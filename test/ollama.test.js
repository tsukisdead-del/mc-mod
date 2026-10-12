// The free local version: Node server + Ollama on the same computer (here, a fake Ollama).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const requests = [];
let rejectThink = false;
const ollama = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const json = body ? JSON.parse(body) : {};
    requests.push(json);
    if (rejectThink && 'think' in json) {
      res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: '"gemma4" does not support thinking' }));
      return;
    }
    if (json.model !== 'gemma4') {
      res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: `model "${json.model}" not found, try pulling it first` }));
      return;
    }
    if (!json.stream) {
      const content = json.messages[0].content.includes('private notes') ? '- Name: Sam' : '[[mood:warm]] hey, thinking of you!';
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message: { role: 'assistant', content }, done: true }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    const pieces = ['[[mood:concerned]] I', "'m here", ' with you.', '\n|||\n', 'Are you safe?'];
    for (const p of pieces) res.write(JSON.stringify({ message: { role: 'assistant', content: p }, done: false }) + '\n');
    res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 900, eval_count: 20 }) + '\n');
  });
});

let mods;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-ollama-'));

before(async () => {
  await new Promise((r) => ollama.listen(0, r));
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.MOCK_AI;
  process.env.DATA_DIR = dataDir;
  process.env.OLLAMA_URL = `http://127.0.0.1:${ollama.address().port}`;
  mods = {
    store: await import('../server/store.js'),
    ai: await import('../server/ai.js'),
    files: await import('../server/attachments.js'),
    config: (await import('../server/config.js')).config,
  };
});

after(async () => {
  await mods.store.flush();
  ollama.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('without a Claude key it uses Ollama', () => {
  assert.equal(mods.config.aiProvider, 'ollama');
  assert.equal(mods.ai.providerInfo().model, 'gemma4');
});

test('replies stream from Ollama with the photo, the safety note and thinking off', async () => {
  const { store, ai, files } = mods;
  const photo = await files.saveUpload({ originalname: 'room.jpg', mimetype: 'image/jpeg', size: 4, buffer: Buffer.from([1, 2, 3, 4]) });
  store.addMessage({ role: 'user', text: 'hi' });
  store.addMessage({ role: 'assistant', text: '[[mood:warm]] hey!' });
  store.addMessage({ role: 'user', text: 'honestly I want to die', attachments: [photo.id] });
  const deltas = [];
  const { raw, risk } = await ai.generateReply({ onDelta: (t) => deltas.push(t) });
  assert.equal(raw, "[[mood:concerned]] I'm here with you.\n|||\nAre you safe?");
  assert.equal(deltas.join(''), raw);
  assert.equal(risk, true);

  const req = requests.at(-1);
  assert.equal(req.model, 'gemma4');
  assert.equal(req.stream, true);
  assert.equal(req.think, false);
  assert.equal(req.options.num_ctx, 16384);
  assert.equal(req.messages[0].role, 'system');
  assert.match(req.messages[0].content, /Format reminders/);
  const last = req.messages.at(-1);
  assert.equal(last.role, 'user');
  assert.deepEqual(last.images, [Buffer.from([1, 2, 3, 4]).toString('base64')]);
  assert.match(last.content, /Safety section/);
});

test('models that reject the thinking switch are retried without it', async () => {
  const { store, ai } = mods;
  rejectThink = true;
  store.addMessage({ role: 'user', text: 'still there?' });
  const { raw } = await ai.generateReply({ onDelta: () => {} });
  rejectThink = false;
  assert.match(raw, /here with you/);
  assert.ok('think' in requests.at(-2));
  assert.ok(!('think' in requests.at(-1)));
});

test('check-ins and memory notes come from Ollama too', async () => {
  const { ai, store } = mods;
  assert.equal(await ai.generateCheckin(), '[[mood:warm]] hey, thinking of you!');
  assert.equal(requests.at(-1).stream, false);
  await ai.maybeUpdateMemory({ force: true });
  assert.equal(store.state.memory.text, '- Name: Sam');
});

test('PDFs are read as text; scans are turned away', async () => {
  const { files } = mods;
  const pdf =
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 55>>stream\nBT /F1 18 Tf 20 100 Td (I felt anxious before my exam.) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF';
  const meta = await files.saveUpload({ originalname: 'journal.pdf', mimetype: 'application/pdf', size: pdf.length, buffer: Buffer.from(pdf) });
  assert.equal(await files.pdfText(meta), 'I felt anxious before my exam.');
  const parts = await files.openModelParts([meta.id], { fresh: new Set(), vision: true, maxChars: 1000 });
  assert.match(parts[0].text, /journal\.pdf[\s\S]*anxious before my exam/);

  const blank = pdf.replace('(I felt anxious before my exam.) Tj', '');
  await assert.rejects(
    files.saveUpload({ originalname: 'scan.pdf', mimetype: 'application/pdf', size: blank.length, buffer: Buffer.from(blank) }),
    /couldn't find any text/,
  );
});

test('when Ollama is closed: a clear message, and check-ins still go out', async () => {
  const { ai, store, config } = mods;
  const url = config.ollamaUrl;
  config.ollamaUrl = 'http://127.0.0.1:9'; // nothing listens here
  store.addMessage({ role: 'user', text: 'hello?' });
  await assert.rejects(ai.generateReply({ onDelta: () => {} }), (err) => /Ollama/.test(ai.friendlyMessage(err)));
  assert.match(await ai.generateCheckin(), /^\[\[mood:/);
  config.ollamaUrl = url;

  config.ollamaModel = 'not-downloaded';
  await assert.rejects(ai.generateReply({ onDelta: () => {} }), (err) => /ollama pull not-downloaded/.test(ai.friendlyMessage(err)));
  config.ollamaModel = 'gemma4';
});
