// The Cloudflare version's SQL (worker/store.js), run against a real SQLite through a small stand-in for D1.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newStore, skipWithoutSqlite as skip } from './helpers/d1.js';
import { chunkText, charsPerToken, CHUNK_CHARS } from '../server/doc-search.js';

const docOf = (text) => ({ text, parts: chunkText(text), tokens: Math.ceil(text.length / charsPerToken(text)) });

test('a database from an older version gets the new columns once', { skip }, async () => {
  const { db, store } = await newStore((db) => {
    db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.exec(
      'CREATE TABLE push_subscriptions (endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, user_agent TEXT, created_at INTEGER NOT NULL)',
    );
    db.exec(
      'CREATE TABLE attachments (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, text TEXT)',
    );
    db.exec("INSERT INTO attachments VALUES ('old1', 1, 'old.txt', 'text', 'text/plain', 5, 'hello there')");
  });
  assert.ok(
    db
      .prepare('PRAGMA table_info(push_subscriptions)')
      .all()
      .some((c) => c.name === 'session'),
  );
  const cols = db
    .prepare('PRAGMA table_info(attachments)')
    .all()
    .map((c) => c.name);
  for (const c of ['chars', 'tokens', 'chunks', 'pages']) assert.ok(cols.includes(c), c);
  assert.equal(await store.get('schema_version'), 9);
  // A document saved before parts existed still reads: its whole text is with the attachment.
  const old = (await store.attachmentMap(['old1'], { text: true })).old1;
  assert.equal(old.chars, 11);
  assert.equal(old.chunks, 0);
  assert.equal(old.text, 'hello there');
  // and a brand-new database is marked up to date too
  const fresh = await newStore();
  assert.equal(await fresh.store.get('schema_version'), 9);
});

test('looking up more than 100 attachments at once works (D1 allows 100 bound parameters)', { skip }, async () => {
  const { store } = await newStore();
  const ids = [];
  for (let i = 0; i < 150; i++) {
    const meta = await store.saveAttachment({ name: `p${i}.jpg`, kind: 'image', mime: 'image/jpeg', size: 3 }, `DATA${i}`);
    ids.push(meta.id);
  }
  const doc = await store.saveAttachment({ name: 'long.txt', kind: 'text', mime: 'text/plain', size: 9 }, null, docOf('x'.repeat(5000)));
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

test('a long document is stored in parts, searchable, and comes back exactly', { skip }, async () => {
  const { store, d1 } = await newStore();
  const paragraphs = Array.from({ length: 600 }, (_, i) =>
    i === 420
      ? 'Natasha went to the opera with Anatole, and it changed everything.'
      : `Paragraph ${i}: the weather was ordinary and nothing much happened that day.`,
  );
  const text = paragraphs.join('\n\n');
  const before = d1.queries;
  const meta = await store.saveAttachment({ name: 'novel.txt', kind: 'text', mime: 'text/plain', size: text.length }, null, docOf(text));
  const parts = chunkText(text);
  assert.ok(parts.length > 10);
  // one batch per 100 parts (indexed in the same transaction), one attachment row
  assert.equal(d1.queries - before, Math.ceil(parts.length / 100) + 1);
  const m = (await store.attachmentMap([meta.id]))[meta.id];
  assert.equal(m.chars, text.length);
  assert.equal(m.chunks, parts.length);
  assert.ok(m.tokens > 1000);
  // The attachment row keeps only the opening; the parts hold all of it.
  assert.equal((await store.attachmentMap([meta.id], { text: true }))[meta.id].text.length, 8000);
  assert.equal((await store.documentTexts([meta.id]))[meta.id], text);

  const hits = await store.searchDocuments([meta.id], '"natasha" OR "operas"', 5);
  assert.equal(hits.length, 1);
  assert.match(hits[0].text, /Natasha went to the opera/);
  assert.ok(text.slice(...parts[hits[0].seq]).includes('Natasha'));
  // Only the documents asked for are searched; a broken query finds nothing instead of failing.
  assert.deepEqual(await store.searchDocuments(['someone-else'], '"natasha"', 5), []);
  assert.deepEqual(await store.searchDocuments([meta.id], 'opera"', 5), []);

  const some = await store.documentParts([
    [meta.id, 0],
    [meta.id, 3],
    [meta.id, 99999],
  ]);
  assert.deepEqual(
    some.map((p) => p.seq).sort((a, b) => a - b),
    [0, 3],
  );
  assert.equal(some.find((p) => p.seq === 3).text, text.slice(...parts[3]));
});

test('deleting history wipes document parts and their search index', { skip }, async () => {
  const { store, db } = await newStore();
  const a = await store.saveAttachment({ name: 'a.txt', kind: 'text', mime: 'text/plain', size: 1 }, null, docOf('apples and pears '.repeat(400)));
  await store.saveAttachment({ name: 'b.txt', kind: 'text', mime: 'text/plain', size: 1 }, null, docOf('bananas '.repeat(400)));
  await store.deleteDocument(a.id);
  assert.deepEqual(await store.searchDocuments([a.id], '"apples"', 5), []);
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM doc_chunks').get().n > 0);
  await store.deleteAllMessages();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM doc_chunks').get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM doc_chunks_fts WHERE doc_chunks_fts MATCH 'bananas'").get().n, 0);
});

test('a failed upload leaves no parts behind', { skip }, async () => {
  const { store, db, d1 } = await newStore();
  const realBatch = d1.batch.bind(d1);
  let calls = 0;
  d1.batch = async (list) => {
    if (++calls === 2) throw new Error('D1_ERROR: overloaded');
    return realBatch(list);
  };
  const text = 'word '.repeat(CHUNK_CHARS * 60);
  await assert.rejects(store.saveAttachment({ name: 'big.txt', kind: 'text', mime: 'text/plain', size: 1 }, null, docOf(text)), /overloaded/);
  d1.batch = realBatch;
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM doc_chunks').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM attachments').get().n, 0);
});

test('an existing database from the first long-document version is re-indexed for all scripts', { skip }, async () => {
  const { store, db } = await newStore((db) => {
    db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.exec(`INSERT INTO kv VALUES ('schema_version', '5')`);
    db.exec('CREATE TABLE doc_chunks (id INTEGER PRIMARY KEY, doc_id TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL)');
    db.exec("CREATE VIRTUAL TABLE doc_chunks_fts USING fts5(body, content='doc_chunks', content_rowid='id', tokenize='porter unicode61 remove_diacritics 2')");
    db.exec("INSERT INTO doc_chunks (doc_id, seq, body) VALUES ('old', 0, 'the lighthouse keeper waved')");
    db.exec('INSERT INTO doc_chunks_fts (rowid, body) SELECT id, body FROM doc_chunks');
  });
  assert.equal(await store.get('schema_version'), 9);
  assert.ok(db.prepare('PRAGMA table_info(doc_chunks)').all().some((c) => c.name === 'search'));
  assert.equal((await store.searchDocuments(['old'], '"lighthouse"', 5)).length, 1);
});

test('Japanese and Chinese documents can be searched too', { skip }, async () => {
  const { store } = await newStore();
  const { queryTerms, ftsQuery } = await import('../server/doc-search.js');
  const text = Array.from({ length: 400 }, (_, i) => (i === 300 ? 'マルグリットはついに火事のことで兄を許した。' : `第${i}段落、今日は静かな一日だった。`)).join('\n\n');
  const meta = await store.saveAttachment({ name: 'novel.txt', kind: 'text', mime: 'text/plain', size: 1 }, null, docOf(text));
  const hits = await store.searchDocuments([meta.id], ftsQuery(queryTerms('マルグリットはなぜ兄を許したの？', { fold: false })), 3);
  assert.ok(hits.length && hits[0].text.includes('マルグリット'));
});

test('search looks only at the documents asked for, even with others stored', { skip }, async () => {
  const { store } = await newStore();
  const a = await store.saveAttachment({ name: 'a.txt', kind: 'text', mime: 'text/plain', size: 1 }, null, docOf('the ferry left at dawn. '.repeat(300)));
  const b = await store.saveAttachment({ name: 'b.txt', kind: 'text', mime: 'text/plain', size: 1 }, null, docOf('the ferry was late again. '.repeat(300)));
  const hits = await store.searchDocuments([a.id], '"ferry"', 50);
  assert.ok(hits.length > 0 && hits.every((h) => h.docId === a.id));
  const both = await store.searchDocuments([a.id, b.id], '"ferry"', 50);
  assert.ok(both.some((h) => h.docId === b.id) && both.some((h) => h.docId === a.id));
});

test('the daily tidy-up removes files never sent and parts left by a cut-off upload', { skip }, async () => {
  const { store, db } = await newStore();
  const day = 24 * 60 * 60 * 1000;
  const sent = await store.saveAttachment({ name: 'sent.txt', kind: 'text', mime: 'text/plain', size: 1 }, null, docOf('kept '.repeat(500)));
  const unsent = await store.saveAttachment({ name: 'unsent.txt', kind: 'text', mime: 'text/plain', size: 1 }, null, docOf('dropped '.repeat(500)));
  await store.addMessage({ role: 'user', text: 'here', attachments: [sent.id] });
  // parts of an upload that never finished (its id says it started two hours ago)
  const orphan = (Date.now() - 2 * 60 * 60 * 1000).toString(36) + 'abcdef0123';
  db.prepare("INSERT INTO doc_chunks (doc_id, seq, body) VALUES (?, 0, 'orphan text')").run(orphan);
  db.prepare("INSERT INTO doc_chunks_fts (rowid, body) SELECT id, body FROM doc_chunks WHERE doc_id = ?").run(orphan);
  // Nothing is old enough yet but the orphan.
  assert.deepEqual(await store.cleanUp(), [orphan]);
  const removed = await store.cleanUp(Date.now() + 2 * day);
  assert.deepEqual(removed, [unsent.id]);
  assert.ok(await store.hasAttachment(sent.id));
  assert.equal(await store.hasAttachment(unsent.id), false);
  assert.deepEqual(await store.searchDocuments([unsent.id, orphan], '"dropped" OR "orphan"', 5), []);
  assert.equal((await store.searchDocuments([sent.id], '"kept"', 5)).length > 0, true);
});
