// Storage for the Cloudflare version, all in one D1 (SQLite) database. Files are kept as base64 text:
// D1 hands BLOBs back as arrays of numbers, which is far too slow for the free plan's 10 ms CPU budget,
// while base64 is what the AI needs anyway. The app state uses the same shape as the Node server's
// state.json, so shared logic works on both.
import { withDefaults } from '../server/settings.js';

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  `CREATE TABLE IF NOT EXISTS messages (
     id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, role TEXT NOT NULL, kind TEXT NOT NULL,
     text TEXT NOT NULL, attachments TEXT NOT NULL DEFAULT '[]', mood TEXT, crisis INTEGER NOT NULL DEFAULT 0)`,
  'CREATE INDEX IF NOT EXISTS messages_by_time ON messages (created_at)',
  `CREATE TABLE IF NOT EXISTS attachments (
     id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
     mime TEXT NOT NULL, size INTEGER NOT NULL, text TEXT)`,
  'CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, data TEXT NOT NULL)',
  `CREATE TABLE IF NOT EXISTS push_subscriptions (
     endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, user_agent TEXT, created_at INTEGER NOT NULL)`,
];

let schemaReady = null;

function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function rowToMessage(r) {
  return {
    id: r.id,
    role: r.role,
    kind: r.kind,
    text: r.text,
    attachments: JSON.parse(r.attachments || '[]'),
    createdAt: r.created_at,
    mood: r.mood || undefined,
    crisis: Boolean(r.crisis),
  };
}

export class Store {
  constructor(env) {
    this.db = env.DB;
  }

  async init() {
    schemaReady ??= this.db.batch(SCHEMA.map((sql) => this.db.prepare(sql))).catch((err) => {
      schemaReady = null;
      throw err;
    });
    await schemaReady;
    return this;
  }

  // ---------- small JSON values ----------

  async get(key, fallback = null) {
    const row = await this.db.prepare('SELECT value FROM kv WHERE key = ?').bind(key).first();
    return row ? JSON.parse(row.value) : fallback;
  }

  async put(key, value) {
    await this.db
      .prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .bind(key, JSON.stringify(value))
      .run();
  }

  // Insert only if missing; returns true when this call created it (safe against races).
  async putIfAbsent(key, value) {
    const res = await this.db.prepare('INSERT OR IGNORE INTO kv (key, value) VALUES (?, ?)').bind(key, JSON.stringify(value)).run();
    return res.meta.changes === 1;
  }

  async delete(key) {
    await this.db.prepare('DELETE FROM kv WHERE key = ?').bind(key).run();
  }

  // Settings, memory notes, check-in schedule and bookkeeping in one round trip.
  async loadState() {
    const { results } = await this.db
      .prepare("SELECT key, value FROM kv WHERE key IN ('settings', 'memory', 'checkin', 'meta')")
      .all();
    const v = Object.fromEntries(results.map((r) => [r.key, JSON.parse(r.value)]));
    const meta = { historyStart: 0, lastUserMessageAt: null, ...(v.meta || {}) };
    return {
      settings: withDefaults(v.settings),
      memory: { text: '', updatedAt: null, coveredUntil: 0, ...(v.memory || {}) },
      checkin: { nextAt: null, lastSentAt: null, unanswered: 0, ...(v.checkin || {}) },
      historyStart: meta.historyStart,
      lastUserMessageAt: meta.lastUserMessageAt,
    };
  }

  async saveState(state, parts = ['settings', 'memory', 'checkin', 'meta']) {
    const values = {
      settings: state.settings,
      memory: state.memory,
      checkin: state.checkin,
      meta: { historyStart: state.historyStart, lastUserMessageAt: state.lastUserMessageAt },
    };
    const stmt = this.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    await this.db.batch(parts.map((k) => stmt.bind(k, JSON.stringify(values[k]))));
  }

  // ---------- messages ----------

  async addMessage({ role, kind = 'chat', text, attachments = [], mood, crisis }) {
    const last = await this.db.prepare('SELECT MAX(created_at) AS t FROM messages').first();
    // Strictly increasing timestamps keep the order stable (Date.now() doesn't advance during CPU work in Workers).
    const createdAt = Math.max(Date.now(), (last?.t || 0) + 1);
    const msg = { id: createdAt.toString(36) + randomHex(5), role, kind, text, attachments, createdAt, mood: mood || undefined, crisis: Boolean(crisis) };
    await this.db
      .prepare('INSERT INTO messages (id, created_at, role, kind, text, attachments, mood, crisis) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(msg.id, createdAt, role, kind, text, JSON.stringify(attachments), mood || null, crisis ? 1 : 0)
      .run();
    return msg;
  }

  // Newest `limit` messages strictly between after/before, oldest first. Also says whether more exist.
  async listMessages({ after = 0, before = Number.MAX_SAFE_INTEGER, limit = 120, oldestFirst = false }) {
    const order = oldestFirst ? 'ASC' : 'DESC';
    const { results } = await this.db
      .prepare(`SELECT * FROM messages WHERE created_at > ? AND created_at < ? ORDER BY created_at ${order} LIMIT ?`)
      .bind(after, before, limit + 1)
      .all();
    const hasMore = results.length > limit;
    const rows = results.slice(0, limit);
    if (!oldestFirst) rows.reverse();
    return { messages: rows.map(rowToMessage), hasMore };
  }

  async messagesSince(createdAt) {
    const { results } = await this.db.prepare('SELECT * FROM messages WHERE created_at >= ? ORDER BY created_at ASC').bind(createdAt).all();
    return results.map(rowToMessage);
  }

  async lastMessage() {
    const row = await this.db.prepare('SELECT * FROM messages ORDER BY created_at DESC LIMIT 1').first();
    return row ? rowToMessage(row) : null;
  }

  // Their messages since your last reply.
  async unansweredUserMessages() {
    const lastReply = await this.db.prepare("SELECT MAX(created_at) AS t FROM messages WHERE role = 'assistant'").first();
    const { results } = await this.db
      .prepare("SELECT * FROM messages WHERE role = 'user' AND created_at > ? ORDER BY created_at ASC")
      .bind(lastReply?.t || 0)
      .all();
    return results.map(rowToMessage);
  }

  async allMessages() {
    const { results } = await this.db.prepare('SELECT * FROM messages ORDER BY created_at ASC').all();
    return results.map(rowToMessage);
  }

  async deleteAllMessages() {
    await this.db.batch([this.db.prepare('DELETE FROM messages'), this.db.prepare('DELETE FROM attachments'), this.db.prepare('DELETE FROM files')]);
  }

  // ---------- attachments ----------

  // base64: the original file (photos always; documents only when small enough to fit in a D1 row).
  async saveAttachment({ name, kind, mime, size, text }, base64) {
    const id = Date.now().toString(36) + randomHex(5);
    const meta = { id, name, kind, mime, size, createdAt: Date.now() };
    const stmts = [
      this.db
        .prepare('INSERT INTO attachments (id, created_at, name, kind, mime, size, text) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(id, meta.createdAt, name, kind, mime, size, text ?? null),
    ];
    if (base64) stmts.push(this.db.prepare('INSERT INTO files (id, data) VALUES (?, ?)').bind(id, base64));
    await this.db.batch(stmts);
    return meta;
  }

  // id -> metadata (and extracted text when withText is true)
  async attachmentMap(ids, { withText = false } = {}) {
    const unique = [...new Set(ids.filter((id) => typeof id === 'string'))];
    if (!unique.length) return {};
    const cols = withText ? '*' : 'id, created_at, name, kind, mime, size';
    const { results } = await this.db
      .prepare(`SELECT ${cols} FROM attachments WHERE id IN (${unique.map(() => '?').join(',')})`)
      .bind(...unique)
      .all();
    return Object.fromEntries(
      results.map((r) => [r.id, { id: r.id, name: r.name, kind: r.kind, mime: r.mime, size: r.size, createdAt: r.created_at, text: r.text ?? undefined }]),
    );
  }

  // The stored original as base64, or null.
  async fileData(id) {
    const row = await this.db.prepare('SELECT data FROM files WHERE id = ?').bind(id).first();
    return row?.data ?? null;
  }

  // ---------- push subscriptions ----------

  async pushSubscriptions() {
    const { results } = await this.db.prepare('SELECT * FROM push_subscriptions').all();
    return results.map((r) => ({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }));
  }

  async addPushSubscription(sub, userAgent) {
    await this.db
      .prepare(
        `INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_agent, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent`,
      )
      .bind(sub.endpoint, sub.keys.p256dh, sub.keys.auth, String(userAgent || '').slice(0, 200), Date.now())
      .run();
  }

  async removePushSubscription(endpoint) {
    await this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(endpoint).run();
  }

  async countPushSubscriptions() {
    const row = await this.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').first();
    return row?.n || 0;
  }
}

// Message shape sent to the browser (attachment ids expanded to metadata), same as the Node server's.
export function publicMessage(m, attachments) {
  return {
    id: m.id,
    role: m.role,
    kind: m.kind,
    text: m.text,
    createdAt: m.createdAt,
    mood: m.mood,
    crisis: m.crisis || false,
    attachments: (m.attachments || [])
      .map((id) => attachments[id])
      .filter(Boolean)
      .map(({ id, name, kind, mime, size }) => ({ id, name, kind, mime, size })),
  };
}
