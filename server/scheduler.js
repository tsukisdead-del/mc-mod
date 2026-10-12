import { state, save, addMessage } from './store.js';
import { FREQUENCIES } from './settings.js';
import { inWindow, nextWindowStart, windowLengthHours } from './time.js';
import { generateCheckin } from './ai.js';
import { notifyMessage } from './push.js';
import { parseReply } from '../public/js/reply-format.js';
import { withLock } from './lock.js';

const HOUR = 60 * 60 * 1000;
// Don't check in if they talked to you very recently.
const QUIET_AFTER_CHAT = 2 * HOUR;
// After this many ignored check-ins, stop until they write back.
const MAX_UNANSWERED = 3;

const listeners = new Set();
export function onCheckin(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function pickNextTime(from) {
  const s = state.settings;
  const c = s.checkins;
  const f = FREQUENCIES[c.frequency];
  const windowHours = windowLengthHours(c.startHour, c.endHour);
  const base = (f.hours ?? (f.perDay === 1 ? 24 : Math.max(1.5, windowHours / f.perDay))) * HOUR;
  // Back off a little for each check-in they haven't answered.
  const interval = base * (1 + 0.5 * state.checkin.unanswered);
  let next = from + interval * (0.8 + Math.random() * 0.4);
  if (!inWindow(next, s.timezone, c.startHour, c.endHour)) {
    const start = nextWindowStart(next, s.timezone, c.startHour, c.endHour);
    const spread = Math.min(2, windowHours / 2) * HOUR;
    next = start + Math.random() * spread;
  }
  return Math.round(next);
}

export function reschedule(from = Date.now()) {
  const c = state.settings.checkins;
  state.checkin.nextAt = c.enabled && state.checkin.unanswered < MAX_UNANSWERED ? pickNextTime(from) : null;
  save();
}

// Called whenever they send a message.
export function noteUserActivity() {
  const hadPaused = state.checkin.unanswered >= MAX_UNANSWERED;
  state.checkin.unanswered = 0;
  state.lastUserMessageAt = Date.now();
  if (hadPaused || !state.checkin.nextAt || state.checkin.nextAt - Date.now() < QUIET_AFTER_CHAT) reschedule();
  save();
}

export async function sendCheckinNow({ manual = false } = {}) {
  return withLock(async () => {
    const raw = await generateCheckin();
    if (!raw) throw new Error('No check-in text was generated');
    const parsed = parseReply(raw);
    const msg = addMessage({ role: 'assistant', kind: 'checkin', text: raw, mood: parsed.mood, crisis: parsed.crisis });
    state.checkin.lastSentAt = msg.createdAt;
    if (!manual) state.checkin.unanswered++;
    reschedule();
    await notifyMessage(raw, 'checkin');
    for (const fn of listeners) fn(msg);
    return msg;
  });
}

async function tick() {
  const c = state.settings.checkins;
  const now = Date.now();
  if (!c.enabled) return;
  if (!state.checkin.nextAt) {
    if (state.checkin.unanswered < MAX_UNANSWERED) reschedule(now);
    return;
  }
  if (now < state.checkin.nextAt) return;

  const s = state.settings;
  const missedBy = now - state.checkin.nextAt;
  const talkedRecently = state.lastUserMessageAt && now - state.lastUserMessageAt < QUIET_AFTER_CHAT;
  // Server was asleep for a long time, it's outside their hours, or they're mid-conversation: pick a new time.
  if (missedBy > 3 * HOUR || talkedRecently || !inWindow(now, s.timezone, c.startHour, c.endHour)) {
    reschedule(talkedRecently ? state.lastUserMessageAt : now);
    return;
  }
  try {
    await sendCheckinNow();
  } catch (err) {
    console.error('Check-in failed:', err.message);
    state.checkin.nextAt = now + HOUR; // try again later
    save();
  }
}

let timer = null;
export function startScheduler() {
  if (timer) return;
  timer = setInterval(() => tick().catch((e) => console.error(e)), 60 * 1000);
  setTimeout(() => tick().catch((e) => console.error(e)), 5000);
}
