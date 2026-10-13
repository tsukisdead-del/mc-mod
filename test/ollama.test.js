// The free local version: Node server + Ollama on the same computer (here, a fake Ollama).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const requests = [];
let rejectThink = false;
let ollamaError = null;
let truncateMemory = false;
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
    if (ollamaError) {
      res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: ollamaError }));
      return;
    }
    if (json.model !== 'gemma4') {
      res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: `model "${json.model}" not found, try pulling it first` }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    const memory = json.messages[0].content.includes('private notes');
    const checkin = json.options.num_predict === 300;
    const pieces = memory ? ['- Name: ', 'Sam'] : checkin ? ['[[mood:warm]] hey, ', 'thinking of you!'] : ['[[mood:concerned]] I', "'m here", ' with you.', '\n|||\n', 'Are you safe?'];
    for (const p of pieces) res.write(JSON.stringify({ message: { role: 'assistant', content: p }, done: false }) + '\n');
    const doneReason = memory && truncateMemory ? 'length' : 'stop';
    res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, done_reason: doneReason, prompt_eval_count: 900, eval_count: 20 }) + '\n');
  });
});

let mods;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-ollama-'));

// What multer's disk storage hands the upload route: the file is already in the uploads folder.
let uploads = 0;
function upload(originalname, mimetype, buffer) {
  const p = path.join(dataDir, 'uploads', `upload-test${++uploads}.tmp`);
  fs.writeFileSync(p, buffer);
  return mods.files.saveUpload({ originalname, mimetype, size: buffer.length, path: p });
}

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
  const photo = await upload('room.jpg', 'image/jpeg', Buffer.from([1, 2, 3, 4]));
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

test('check-ins and memory notes come from Ollama too (streamed, so slow computers never time out)', async () => {
  const { ai, store } = mods;
  assert.equal(await ai.generateCheckin(), '[[mood:warm]] hey, thinking of you!');
  assert.equal(requests.at(-1).stream, true);
  // Notes that come back cut off at the token limit don't replace the old ones.
  truncateMemory = true;
  await ai.maybeUpdateMemory({ force: true });
  truncateMemory = false;
  assert.equal(store.state.memory.text, '');
  await ai.maybeUpdateMemory({ force: true });
  assert.equal(store.state.memory.text, '- Name: Sam');
});

test('PDFs are read as text; scans are turned away', async () => {
  const { files } = mods;
  const pdf =
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 55>>stream\nBT /F1 18 Tf 20 100 Td (I felt anxious before my exam.) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF';
  const meta = await upload('journal.pdf', 'application/pdf', Buffer.from(pdf));
  assert.equal(meta.pages, 1);
  assert.equal(fs.readFileSync(path.join(dataDir, 'uploads', meta.textFile), 'utf8').trim(), 'I felt anxious before my exam.');

  const blank = pdf.replace('(I felt anxious before my exam.) Tj', '');
  await assert.rejects(upload('scan.pdf', 'application/pdf', Buffer.from(blank)), /couldn't find any text/);
  // nothing is left behind in the uploads folder
  assert.ok(!fs.readdirSync(path.join(dataDir, 'uploads')).some((f) => f.startsWith('upload-')));
});

test('when Ollama is closed: a clear message, and check-ins still go out', async () => {
  const { ai, store, config } = mods;
  const url = config.ollamaUrl;
  const closed = http.createServer();
  await new Promise((r) => closed.listen(0, r));
  const port = closed.address().port;
  await new Promise((r) => closed.close(r));
  config.ollamaUrl = `http://127.0.0.1:${port}`; // nothing listens here any more
  store.addMessage({ role: 'user', text: 'hello?' });
  await assert.rejects(ai.generateReply({ onDelta: () => {} }), (err) => /Ollama/.test(ai.friendlyMessage(err)));
  assert.match(await ai.generateCheckin(), /^\[\[mood:/);
  config.ollamaUrl = url;

  config.ollamaModel = 'not-downloaded';
  await assert.rejects(ai.generateReply({ onDelta: () => {} }), (err) => /ollama pull not-downloaded/.test(ai.friendlyMessage(err)));
  config.ollamaModel = 'gemma4';

  // Ollama itself failing is reported as such, with a hint when it's out of memory.
  ollamaError = 'model requires more system memory (9.6 GiB) than is available (5.1 GiB)';
  await assert.rejects(ai.generateReply({ onDelta: () => {} }), (err) => /smaller model/.test(ai.friendlyMessage(err)));
  ollamaError = 'something odd';
  await assert.rejects(ai.generateReply({ onDelta: () => {} }), (err) => /Ollama had a problem \(500\): something odd/.test(ai.friendlyMessage(err)));
  ollamaError = null;
});

// A simple many-page PDF (one line of text per page).
function makePdf(lines) {
  const objs = ['<</Type/Catalog/Pages 2 0 R>>', `<</Type/Pages/Kids[${lines.map((_, i) => `${3 + i * 2} 0 R`).join(' ')}]/Count ${lines.length}>>`];
  lines.forEach((line, i) => {
    // wrap into lines that fit the page width
    const rows = line.match(/.{1,80}(\s|$)/g) || [''];
    const stream = `BT /F1 10 Tf 20 760 Td 12 TL ${rows.map((r) => `(${r.trim()}) Tj T*`).join(' ')} ET`;
    objs.push(`<</Type/Page/Parent 2 0 R/MediaBox[0 0 600 792]/Contents ${4 + i * 2} 0 R/Resources<</Font<</F1 ${3 + lines.length * 2} 0 R>>>>>>`);
    objs.push(`<</Length ${stream.length}>>stream\n${stream}\nendstream`);
  });
  objs.push('<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>');
  return Buffer.from(`%PDF-1.4\n${objs.map((o, i) => `${i + 1} 0 obj${o}endobj`).join('\n')}\ntrailer<</Root 1 0 R>>\n%%EOF`);
}

test('a long document: the local model gets its opening and the part they ask about, within its window', async () => {
  const { store, ai } = mods;
  const paragraphs = Array.from({ length: 1500 }, (_, i) =>
    i === 1200 ? 'In the winter of that year Eleanor finally called her father and they talked for hours.' : `Paragraph ${i}: an ordinary day at the office, nothing to report.`,
  );
  const book = await upload('memoir.txt', 'text/plain', Buffer.from(paragraphs.join('\n\n')));
  assert.ok(book.chars > 90000);
  store.addMessage({ role: 'user', text: 'what happened when Eleanor called her father?', attachments: [book.id] });
  await ai.generateReply({ onDelta: () => {} });
  const req = requests.at(-1);
  const all = JSON.stringify(req.messages);
  assert.match(all, /Long document they sent: \\"memoir.txt\\"/);
  assert.match(req.messages.at(-1).content, /Eleanor finally called her father/);
  // Everything sent stays well inside the 16k-token window.
  assert.ok(all.length < 40000, `sent ${all.length} chars`);
});

test('a long PDF: matching pages are found and labelled with their page numbers', async () => {
  const { store, ai } = mods;
  const filler = 'Quarterly budgets, spreadsheets, invoices and meeting notes. '.repeat(8);
  const pages = Array.from({ length: 60 }, (_, i) =>
    i === 41 ? `The therapist said the panic attacks were her body trying to protect her. ${filler}` : `Page ${i + 1}. ${filler}`,
  );
  const pdf = await upload('notes.pdf', 'application/pdf', makePdf(pages));
  assert.equal(pdf.pages, 60);
  store.addMessage({ role: 'assistant', text: '[[mood:warm]] got it' });
  store.addMessage({ role: 'user', text: 'what did the therapist say about the panic attacks?', attachments: [pdf.id] });
  await ai.generateReply({ onDelta: () => {} });
  const last = requests.at(-1).messages.at(-1).content;
  const hit = last.match(/--- pages? (\d+)(?:–(\d+))? ---\n(?:(?!---)[\s\S])*panic attacks were her body trying to protect her/);
  assert.ok(hit, 'the matching page is included');
  assert.ok(Number(hit[1]) <= 42 && 42 <= Number(hit[2] || hit[1]), `labelled ${hit[0].split('\n')[0]}`);
  // an older document nobody asked about adds nothing
  assert.doesNotMatch(last, /memoir/);
});

test('with Claude, a small PDF goes as itself and a long one as text', async () => {
  const { files, store } = mods;
  const small = await upload('one-page.pdf', 'application/pdf', makePdf(['A short letter to my younger self.']));
  const big = await upload('book.pdf', 'application/pdf', makePdf(Array.from({ length: 150 }, (_, i) => `Chapter line ${i} with plenty of words to read.`)));
  const msg = store.addMessage({ role: 'user', text: 'two pdfs', attachments: [small.id, big.id] });
  const turns = [{ role: 'user', content: [{ type: 'files', ids: [small.id, big.id] }] }];
  const f = await files.prepareFiles({ turns, messages: [msg], fresh: new Set([small.id, big.id]), query: '', budget: { inlineFresh: 100000, inlineOlder: 100000, excerpts: 20000, overview: 1500, maxParts: 30 }, claude: true });
  const blocks = await files.claudeParts([small.id, big.id], f);
  assert.equal(blocks[0].type, 'document');
  assert.equal(blocks[0].source.media_type, 'application/pdf');
  // the long one as its text, in a document block of its own
  assert.equal(blocks[1].type, 'document');
  assert.equal(blocks[1].title, 'book.pdf');
  assert.equal(blocks[1].source.type, 'text');
  assert.match(blocks[1].source.data, /Chapter line 149/);
});

test('uploads are private to this user, and leftovers from a crash are cleared at startup', async () => {
  const { files } = mods;
  const meta = await upload('diary.txt', 'text/plain', Buffer.from('dear diary'));
  const dir = path.join(dataDir, 'uploads');
  assert.equal(fs.statSync(path.join(dir, meta.file)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dir, meta.textFile)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  fs.writeFileSync(path.join(dir, 'zzz123.pdf'), 'half an upload');
  files.removeStrayFiles();
  assert.ok(!fs.existsSync(path.join(dir, 'zzz123.pdf')));
  assert.ok(fs.existsSync(path.join(dir, meta.file)));
});

test('a Word file that inflates to something huge is turned away without hurting the server', async () => {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file('word/document.xml', `<w:document><w:body>${'<w:p><w:r><w:t>aaaaaaaaaa</w:t></w:r></w:p>'.repeat(1_200_000)}</w:body></w:document>`);
  const bomb = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  assert.ok(bomb.length < 2_000_000, `zip is ${bomb.length} bytes`);
  const t = Date.now();
  await assert.rejects(upload('bomb.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bomb), /too long|too big/);
  assert.ok(Date.now() - t < 60000);
  // a normal Word file still works
  const ok = new JSZip();
  ok.file('[Content_Types].xml', '<Types/>');
  ok.file('word/document.xml', '<w:document><w:body><w:p><w:r><w:t>Hello from Word</w:t></w:r></w:p></w:body></w:document>');
  const meta = await upload('letter.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', await ok.generateAsync({ type: 'nodebuffer' }));
  assert.equal(fs.readFileSync(path.join(dataDir, 'uploads', meta.textFile), 'utf8').trim(), 'Hello from Word');
});

test('chapters and pages can be asked for; small talk leaves older documents alone', async () => {
  const { store, ai } = mods;
  const chapters = Array.from({ length: 12 }, (_, c) =>
    [`CHAPTER ${c + 1}`, ...Array.from({ length: 30 }, (_, i) => (c === 7 && i === 0 ? 'Rain fell on the orchard as Ada read the letter.' : `Line ${i} of chapter ${c + 1}, nothing happens.`))].join('\n\n'),
  );
  const novel = await upload('novel.txt', 'text/plain', Buffer.from(chapters.join('\n\n')));
  store.addMessage({ role: 'user', text: 'my favourite novel', attachments: [novel.id] });
  store.addMessage({ role: 'assistant', text: '[[mood:warm]] lovely' });
  store.addMessage({ role: 'user', text: 'what happens in chapter 8?' });
  await ai.generateReply({ onDelta: () => {} });
  assert.match(requests.at(-1).messages.at(-1).content, /CHAPTER 8[\s\S]*Ada read the letter/);
  store.addMessage({ role: 'assistant', text: '[[mood:warm]] it rains' });
  for (let i = 0; i < 4; i++) {
    store.addMessage({ role: 'user', text: `ok ${i}` });
    store.addMessage({ role: 'assistant', text: '[[mood:warm]] mm' });
  }
  store.addMessage({ role: 'user', text: 'I feel tired today, nothing happens at work and my boss yelled' });
  await ai.generateReply({ onDelta: () => {} });
  assert.doesNotMatch(requests.at(-1).messages.at(-1).content, /Parts of/);
});

test('a document whose text file went missing becomes a placeholder; replies still work', async () => {
  const { store, ai } = mods;
  const meta = await upload('gone.txt', 'text/plain', Buffer.from('soon to vanish '.repeat(5000)));
  fs.rmSync(path.join(dataDir, 'uploads', meta.textFile));
  store.addMessage({ role: 'user', text: 'did you read it?', attachments: [meta.id] });
  const { raw } = await ai.generateReply({ onDelta: () => {} });
  assert.ok(raw.length > 0);
  assert.match(JSON.stringify(requests.at(-1).messages), /They sent a file: gone.txt/);
});

test('Claude gets at most 20 MB of PDFs as themselves in one request', async () => {
  const { files, store } = mods;
  const padded = (label) => {
    const pdf = makePdf([`${label}: a short scanned form.`]).toString('latin1');
    // ~9 MB of padding in an unused object, as a photo-heavy scan would be
    return Buffer.from(pdf.replace('trailer', `99 0 obj<</Length 9000000>>stream\n${' '.repeat(9_000_000)}\nendstream endobj\ntrailer`), 'latin1');
  };
  const pdfs = [];
  for (const label of ['A', 'B', 'C']) pdfs.push(await upload(`${label}.pdf`, 'application/pdf', padded(label)));
  const msg = store.addMessage({ role: 'user', text: 'three forms', attachments: pdfs.map((p) => p.id) });
  const turns = [{ role: 'user', content: [{ type: 'files', ids: pdfs.map((p) => p.id) }] }];
  const f = await files.prepareFiles({ turns, messages: [msg], fresh: new Set(pdfs.map((p) => p.id)), query: '', budget: { inlineFresh: 100000, inlineOlder: 100000, excerpts: 20000, overview: 1500, maxParts: 30, stable: true }, claude: true });
  assert.equal(f.native.size, 2);
  assert.ok(!f.native.has(pdfs[0].id), 'the newest go as themselves');
});

test('a Word file with a huge styles part is read with the light reader, not mammoth', async () => {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file('word/document.xml', '<w:document><w:body><w:p><w:r><w:t>Hello from a heavy Word file</w:t></w:r></w:p></w:body></w:document>');
  zip.file('word/styles.xml', `<w:styles>${'<w:style w:styleId="x"><w:name w:val="x"/></w:style>'.repeat(600_000)}</w:styles>`);
  const docx = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const t = Date.now();
  const meta = await upload('heavy.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', docx);
  assert.equal(fs.readFileSync(path.join(dataDir, 'uploads', meta.textFile), 'utf8').trim(), 'Hello from a heavy Word file');
  assert.ok(Date.now() - t < 3000, `took ${Date.now() - t} ms; mammoth takes several seconds here`);
});

test('a file still being read when the chat history is deleted is deleted too', async () => {
  const { files } = mods;
  const pending = upload('late.txt', 'text/plain', Buffer.from('a long letter '.repeat(20000)));
  await files.deleteAllAttachments();
  await assert.rejects(pending, /history was deleted/);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'uploads')), []);
});
