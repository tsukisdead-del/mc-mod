import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { withDefaults } from './settings.js';

// Everything lives in one JSON file (plus uploaded files) — this is a one-person app.

const STATE_FILE = path.join(config.dataDir, 'state.json');
export const UPLOAD_DIR = path.join(config.dataDir, 'uploads');

// Private to this user: chats, photos and documents.
fs.mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 });
for (const dir of [config.dataDir, UPLOAD_DIR]) {
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // e.g. a mounted volume that doesn't allow it
  }
}

function emptyState() {
  return {
    version: 1,
    settings: withDefaults(null),
    messages: [], // { id, role: 'user'|'assistant', kind: 'chat'|'checkin', text, attachments: [id], createdAt, mood?, crisis? }
    attachments: {}, // id -> { id, name, kind: 'image'|'pdf'|'text', mime, size, file, textFile?, createdAt }
    memory: { text: '', updatedAt: null, coveredUntil: 0 },
    historyStart: 0, // createdAt of the oldest message still sent to the model verbatim
    pushSubscriptions: [],
    checkin: { nextAt: null, lastSentAt: null, unanswered: 0 },
    lastUserMessageAt: null,
  };
}

// Set when state.json exists but couldn't be read: nothing may then be cleaned up as if it were unused.
export let loadError = null;

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const base = emptyState();
    return {
      ...base,
      ...raw,
      settings: withDefaults(raw.settings),
      memory: { ...base.memory, ...(raw.memory || {}) },
      checkin: { ...base.checkin, ...(raw.checkin || {}) },
    };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      loadError = err;
      console.error('Could not read state file, starting fresh:', err.message);
    }
    return emptyState();
  }
}

export const state = load();

let writeTimer = null;
let writing = Promise.resolve();

function writeNow() {
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  const data = JSON.stringify(state);
  writing = writing
    .then(async () => {
      await fs.promises.writeFile(tmp, data, { mode: 0o600 });
      await fs.promises.rename(tmp, STATE_FILE);
    })
    .catch((err) => console.error('Failed to save state:', err));
  return writing;
}

export function save() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(writeNow, 150);
}

export async function flush() {
  clearTimeout(writeTimer);
  await writeNow();
}

export function newId() {
  return Date.now().toString(36) + crypto.randomBytes(5).toString('hex');
}

let lastCreatedAt = state.messages.at(-1)?.createdAt || 0;
// Strictly increasing timestamps keep message order stable even within the same millisecond.
function nextTimestamp() {
  lastCreatedAt = Math.max(Date.now(), lastCreatedAt + 1);
  return lastCreatedAt;
}

export function addMessage({ role, text, kind = 'chat', attachments = [], mood, crisis }) {
  const msg = { id: newId(), role, kind, text, attachments, createdAt: nextTimestamp() };
  if (mood) msg.mood = mood;
  if (crisis) msg.crisis = true;
  state.messages.push(msg);
  save();
  return msg;
}

// Shape sent to the browser: attachment ids expanded into metadata.
export function publicMessage(m) {
  return {
    id: m.id,
    role: m.role,
    kind: m.kind,
    text: m.text,
    createdAt: m.createdAt,
    mood: m.mood,
    crisis: m.crisis || false,
    attachments: (m.attachments || [])
      .map((id) => state.attachments[id])
      .filter(Boolean)
      .map(({ id, name, kind, mime, size }) => ({ id, name, kind, mime, size })),
  };
}
