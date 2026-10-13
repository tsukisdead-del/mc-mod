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
     endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, user_agent TEXT, created_at INTEGER NOT NULL, session TEXT)`,
];
// Changes for databases made by an older version of this file, applied once (tracked in kv 'schema_version').
const MIGRATIONS = [
  // 1: tie push subscriptions to the session that registered them
  'ALTER TABLE push_subscriptions ADD COLUMN session TEXT',
];

let schemaReady = null;

function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function uniqueIds(ids) {
  return [...new Set((ids || []).filter((id) => typeof id === 'string'))];
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
    schemaReady ??= this.migrate().catch((err) => {
      schemaReady = null;
      throw err;
    });
    await schemaReady;
    return this;
  }

  async migrate() {
    const results = await this.db.batch([
      ...SCHEMA.map((sql) => this.db.prepare(sql)),
      this.db.prepare("SELECT value FROM kv WHERE key = 'schema_version'"),
    ]);
    const done = Number(JSON.parse(results.at(-1).results[0]?.value ?? '0'));
    if (done >= MIGRATIONS.length) return;
    for (const sql of MIGRATIONS.slice(done)) {
      try {
        await this.db.prepare(sql).run();
      } catch (err) {
        // A brand-new database already has the column from SCHEMA.
        if (!/duplicate column/i.test(String(err?.message))) throw err;
      }
    }
    await this.put('schema_version', MIGRATIONS.length);
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

  // Atomically adds `by` to a counter that starts over after `windowMs`. Returns the new count.
  async bump(key, windowMs, by = 1) {
    const now = Date.now();
    const row = await this.db
      .prepare(
        `INSERT INTO kv (key, value) VALUES (?1, json_object('count', MAX(?4, 0), 'resetAt', ?3))
         ON CONFLICT(key) DO UPDATE SET value = CASE
           WHEN json_extract(kv.value, '$.resetAt') > ?2 THEN json_set(kv.value, '$.count', MAX(json_extract(kv.value, '$.count') + ?4, 0))
           ELSE json_object('count', MAX(?4, 0), 'resetAt', ?3) END
         RETURNING value`,
      )
      .bind(key, now, now + windowMs, by)
      .first();
    return JSON.parse(row.value).count;
  }

  // Adds to today's free-AI usage in one statement (a reply and a memory update can finish at the same time).
  async addUsage(day, neurons) {
    await this.db
      .prepare(
        `INSERT INTO kv (key, value) VALUES ('usage', json_object('day', ?1, 'neurons', ?2))
         ON CONFLICT(key) DO UPDATE SET value = CASE
           WHEN json_extract(kv.value, '$.day') = ?1 THEN json_set(kv.value, '$.neurons', json_extract(kv.value, '$.neurons') + ?2)
           ELSE json_object('day', ?1, 'neurons', ?2) END`,
      )
      .bind(day, neurons)
      .run();
  }

  // Drops counters whose window has ended.
  async dropExpired(prefix) {
    await this.db
      .prepare("DELETE FROM kv WHERE key LIKE ? AND json_extract(value, '$.resetAt') < ?")
      .bind(`${prefix}%`, Date.now())
      .run();
  }

  // A short-lived lock (it expires on its own if the Worker is stopped). Returns a token, or null if it's taken.
  async lease(key, ms) {
    const token = randomHex(8);
    const now = Date.now();
    const res = await this.db
      .prepare(
        `INSERT INTO kv (key, value) VALUES (?1, json_object('token', ?2, 'until', ?3))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE json_extract(kv.value, '$.until') < ?4`,
      )
      .bind(key, token, now + ms, now)
      .run();
    return res.meta.changes === 1 ? token : null;
  }

  async release(key, token) {
    await this.db.prepare("DELETE FROM kv WHERE key = ? AND json_extract(value, '$.token') = ?").bind(key, token).run();
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

  async addMessage(message, options) {
    return (await this.addMessages([message], options))[0];
  }

  // Saves messages in order with one round trip. Timestamps are strictly increasing, and picked inside the
  // insert, so two requests at once can't get the same one (Date.now() also doesn't advance during CPU work).
  // `after`: for a reply, the time of the last message it answers. If they've sent more since, the reply goes
  // right after the messages it answers, so the newer ones still count as waiting for an answer.
  async addMessages(list, { after = null } = {}) {
    if (!list.length) return [];
    const now = Date.now();
    const msgs = list.map(({ role, kind = 'chat', text, attachments = [], mood, crisis }) => ({
      id: now.toString(36) + randomHex(5),
      role,
      kind,
      text,
      attachments,
      mood: mood || undefined,
      crisis: Boolean(crisis),
    }));
    const stmt = this.db.prepare(
      `INSERT INTO messages (id, created_at, role, kind, text, attachments, mood, crisis)
       SELECT ?1, CASE
           WHEN ?9 IS NOT NULL AND MAX(created_at) > ?9 AND NOT EXISTS (SELECT 1 FROM messages WHERE created_at = ?9 + 1) THEN ?9 + 1
           ELSE MAX(?2, COALESCE(MAX(created_at), 0) + 1) END,
         ?3, ?4, ?5, ?6, ?7, ?8 FROM messages
       RETURNING created_at`,
    );
    const results = await this.db.batch(
      msgs.map((m) => stmt.bind(m.id, now, m.role, m.kind, m.text, JSON.stringify(m.attachments), m.mood || null, m.crisis ? 1 : 0, after)),
    );
    msgs.forEach((m, i) => (m.createdAt = results[i].results[0].created_at));
    return msgs;
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

  // id -> metadata. `text`: true adds the extracted text, a number adds only its first that-many characters.
  // The ids go in as one JSON value: D1 allows only 100 bound parameters per query.
  async attachmentMap(ids, { text = false } = {}) {
    const unique = uniqueIds(ids);
    if (!unique.length) return {};
    const textCol = text === true ? ', text' : text ? ', substr(text, 1, ?2) AS text' : '';
    const stmt = this.db.prepare(`SELECT id, created_at, name, kind, mime, size${textCol} FROM attachments WHERE id IN (SELECT value FROM json_each(?1))`);
    const { results } = await (typeof text === 'number' ? stmt.bind(JSON.stringify(unique), text) : stmt.bind(JSON.stringify(unique))).all();
    return Object.fromEntries(
      results.map((r) => [r.id, { id: r.id, name: r.name, kind: r.kind, mime: r.mime, size: r.size, createdAt: r.created_at, text: r.text ?? undefined }]),
    );
  }

  // id -> the stored original as base64, for every id that has one.
  async fileData(ids) {
    const unique = uniqueIds(ids);
    if (!unique.length) return {};
    const { results } = await this.db.prepare('SELECT id, data FROM files WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(unique)).all();
    return Object.fromEntries(results.map((r) => [r.id, r.data]));
  }

  // ---------- push subscriptions ----------

  async pushSubscriptions() {
    const { results } = await this.db.prepare('SELECT * FROM push_subscriptions').all();
    return results.map((r) => ({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth }, session: r.session }));
  }

  // `session` identifies the login that registered the device, so changing the access code cuts it off.
  async addPushSubscription(sub, userAgent, session) {
    await this.db
      .prepare(
        `INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_agent, created_at, session) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent, session = excluded.session`,
      )
      .bind(sub.endpoint, sub.keys.p256dh, sub.keys.auth, String(userAgent || '').slice(0, 200), Date.now(), session)
      .run();
  }

  async removePushSubscription(endpoint) {
    await this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(endpoint).run();
  }

  // Drops devices registered under any other login (an old access code, or none).
  async removeOtherPushSessions(session) {
    await this.db.prepare('DELETE FROM push_subscriptions WHERE session IS NULL OR session != ?').bind(session).run();
  }

  async countPushSubscriptions(session) {
    const row = await this.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE session = ?').bind(session).first();
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
