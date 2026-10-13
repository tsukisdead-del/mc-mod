// The Cloudflare version's SQL (worker/store.js), run against a real SQLite through a small stand-in for D1.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let sqlite = null;
try {
  sqlite = await import('node:sqlite');
} catch {
  // Node without built-in SQLite: these tests are skipped.
}

// Just enough of the D1 binding: prepare/bind/first/all/run and batch (one transaction).
function fakeD1(db) {
  const returnsRows = (sql) => /^\s*(SELECT|WITH)\b|\bRETURNING\b/i.test(sql);
  const statement = (sql, params = []) => ({
    bind: (...p) => statement(sql, p),
    async first() {
      return db.prepare(sql).get(...params) ?? null;
    },
    async all() {
      return { results: db.prepare(sql).all(...params) };
    },
    async run() {
      return this.exec();
    },
    exec() {
      const st = db.prepare(sql);
      if (returnsRows(sql)) {
        const results = st.all(...params);
        return { results, meta: { changes: results.length } };
      }
      return { results: [], meta: { changes: Number(st.run(...params).changes) } };
    },
  });
  return {
    prepare: (sql) => statement(sql),
    async batch(list) {
      db.exec('BEGIN');
      try {
        const out = list.map((s) => s.exec());
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
}

// A fresh copy of store.js per database (it remembers per isolate that the schema is ready).
let copies = 0;
async function newStore(setup) {
  const db = new sqlite.DatabaseSync(':memory:');
  setup?.(db);
  const { Store } = await import(`../worker/store.js?copy=${++copies}`);
  return { db, store: await new Store({ DB: fakeD1(db) }).init() };
}

const skip = !sqlite && 'node:sqlite is not available';

test('a database from before push sessions gets the new column once', { skip }, async () => {
  const { db, store } = await newStore((db) => {
    db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.exec(
      'CREATE TABLE push_subscriptions (endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, user_agent TEXT, created_at INTEGER NOT NULL)',
    );
  });
  assert.ok(
    db
      .prepare('PRAGMA table_info(push_subscriptions)')
      .all()
      .some((c) => c.name === 'session'),
  );
  assert.equal(await store.get('schema_version'), 1);
  // and a brand-new database is marked up to date too
  const fresh = await newStore();
  assert.equal(await fresh.store.get('schema_version'), 1);
});

test('looking up more than 100 attachments at once works (D1 allows 100 bound parameters)', { skip }, async () => {
  const { store } = await newStore();
  const ids = [];
  for (let i = 0; i < 150; i++) {
    const meta = await store.saveAttachment({ name: `p${i}.jpg`, kind: 'image', mime: 'image/jpeg', size: 3 }, `DATA${i}`);
    ids.push(meta.id);
  }
  const doc = await store.saveAttachment({ name: 'long.txt', kind: 'text', mime: 'text/plain', size: 9, text: 'x'.repeat(5000) }, null);
  const metas = await store.attachmentMap([...ids, doc.id, 'missing', ids[0]]);
  assert.equal(Object.keys(metas).length, 151);
  assert.equal(metas[doc.id].text, undefined);
  assert.equal((await store.attachmentMap([doc.id], { text: 100 }))[doc.id].text.length, 100);
  assert.equal((await store.attachmentMap([doc.id], { text: true }))[doc.id].text.length, 5000);
  const files = await store.fileData([...ids, doc.id]);
  assert.equal(Object.keys(files).length, 150);
  assert.equal(files[ids[149]], 'DATA149');
});

test('messages get strictly increasing times; a late reply goes right after what it answers', { skip }, async () => {
  const { store } = await newStore();
  const a = await store.addMessage({ role: 'user', text: 'one' });
  // They send more a few seconds later, while the reply to "one" is still being written.
  const realNow = Date.now;
  Date.now = () => realNow() + 5000;
  let b, c;
  try {
    [b, c] = await store.addMessages([
      { role: 'user', text: 'two' },
      { role: 'user', text: 'three' },
    ]);
  } finally {
    Date.now = realNow;
  }
  assert.ok(a.createdAt < b.createdAt && b.createdAt < c.createdAt);
  // The reply only saw "one": it lands right after it, so "two" and "three" still wait for an answer.
  const reply = await store.addMessage({ role: 'assistant', text: 'hi' }, { after: a.createdAt });
  assert.equal(reply.createdAt, a.createdAt + 1);
  assert.deepEqual(
    (await store.unansweredUserMessages()).map((m) => m.text),
    ['two', 'three'],
  );
  // Nothing newer than what it answers: it simply goes last.
  const reply2 = await store.addMessage({ role: 'assistant', text: 'hey' }, { after: c.createdAt });
  assert.ok(reply2.createdAt > c.createdAt);
  assert.equal((await store.lastMessage()).text, 'hey');
  assert.deepEqual(await store.unansweredUserMessages(), []);
});

test('guess counters are atomic, start over after their window, and never go below zero', { skip }, async () => {
  const { db, store } = await newStore();
  const counts = await Promise.all(Array.from({ length: 25 }, () => store.bump('login:1.2.3.4', 60000)));
  assert.deepEqual(
    counts.sort((x, y) => x - y),
    Array.from({ length: 25 }, (_, i) => i + 1),
  );
  assert.equal(await store.bump('login:1.2.3.4', 60000, -1), 24);
  assert.equal(await store.bump('login:new', 60000, -1), 0);
  db.prepare("UPDATE kv SET value = json_set(value, '$.resetAt', 1) WHERE key = 'login:1.2.3.4'").run();
  assert.equal(await store.bump('login:1.2.3.4', 60000), 1);
  db.prepare("UPDATE kv SET value = json_set(value, '$.resetAt', 1) WHERE key = 'login:new'").run();
  await store.dropExpired('login:');
  assert.equal(await store.get('login:new'), null);
  assert.notEqual(await store.get('login:1.2.3.4'), null);
});

test('the reply lock is held by one request at a time and expires on its own', { skip }, async () => {
  const { db, store } = await newStore();
  const first = await store.lease('replying', 60000);
  assert.ok(first);
  assert.equal(await store.lease('replying', 60000), null);
  await store.release('replying', 'not-the-owner');
  assert.equal(await store.lease('replying', 60000), null);
  await store.release('replying', first);
  const second = await store.lease('replying', 60000);
  assert.ok(second);
  db.prepare("UPDATE kv SET value = json_set(value, '$.until', 1) WHERE key = 'replying'").run();
  assert.ok(await store.lease('replying', 60000), 'an expired lock can be taken over');
});

test('free AI usage adds up per day', { skip }, async () => {
  const { store } = await newStore();
  await Promise.all([store.addUsage('2026-10-13', 10.5), store.addUsage('2026-10-13', 2)]);
  assert.deepEqual(await store.get('usage'), { day: '2026-10-13', neurons: 12.5 });
  await store.addUsage('2026-10-14', 3);
  assert.deepEqual(await store.get('usage'), { day: '2026-10-14', neurons: 3 });
});

test('push devices are tied to the login that registered them', { skip }, async () => {
  const { store } = await newStore();
  const sub = (n) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${n}`, keys: { p256dh: 'k', auth: 'a' } });
  await store.addPushSubscription(sub(1), 'phone', 'old-code');
  await store.addPushSubscription(sub(2), 'laptop', 'current');
  assert.equal(await store.countPushSubscriptions('current'), 1);
  await store.removeOtherPushSessions('current');
  assert.deepEqual(
    (await store.pushSubscriptions()).map((s) => s.endpoint),
    [sub(2).endpoint],
  );
  // Registering again under the new code moves the device over.
  await store.addPushSubscription(sub(2), 'laptop', 'newer');
  assert.equal(await store.countPushSubscriptions('newer'), 1);
});
