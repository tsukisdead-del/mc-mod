import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAI, friendlyMessage, DEFAULT_WORKERS_MODEL } from '../worker/ai.js';
import { defaultSettings } from '../server/settings.js';
import { CRISIS_NOTE } from '../server/safety.js';

// In-memory stand-in for worker/store.js (only what ai.js uses).
function fakeStore({ messages = [], attachments = {}, files = {} } = {}) {
  const kv = new Map();
  return {
    messages,
    saved: [],
    async messagesSince(t) {
      return messages.filter((m) => m.createdAt >= t);
    },
    queries: [],
    async attachmentMap(ids, { text = false } = {}) {
      this.queries.push({ attachmentMap: ids, text });
      const cut = (a) => (text === true ? a : { ...a, text: typeof text === 'number' ? a.text?.slice(0, text) : undefined });
      return Object.fromEntries(ids.filter((id) => attachments[id]).map((id) => [id, cut(attachments[id])]));
    },
    async fileData(ids) {
      this.queries.push({ fileData: ids });
      return Object.fromEntries(ids.filter((id) => files[id]).map((id) => [id, files[id]]));
    },
    async addUsage(day, neurons) {
      const u = kv.get('usage');
      kv.set('usage', { day, neurons: (u?.day === day ? u.neurons : 0) + neurons });
    },
    async unansweredUserMessages() {
      const out = [];
      for (let i = messages.length - 1; i >= 0 && messages[i].role === 'user'; i--) out.unshift(messages[i]);
      return out;
    },
    async lastMessage() {
      return messages.at(-1) ?? null;
    },
    async get(k, fallback = null) {
      return kv.has(k) ? kv.get(k) : fallback;
    },
    async put(k, v) {
      kv.set(k, v);
    },
    async saveState(state, parts) {
      this.saved.push(parts);
    },
  };
}

function state() {
  return {
    settings: { ...defaultSettings(), timezone: 'UTC' },
    memory: { text: '', updatedAt: null, coveredUntil: 0 },
    checkin: { nextAt: null, lastSentAt: null, unanswered: 0 },
    historyStart: 0,
    lastUserMessageAt: null,
  };
}

function sse(lines) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      // Split mid-line to make sure the parser buffers correctly.
      const all = lines.map((l) => `data: ${typeof l === 'string' ? l : JSON.stringify(l)}\n\n`).join('');
      for (let i = 0; i < all.length; i += 17) c.enqueue(enc.encode(all.slice(i, i + 17)));
      c.close();
    },
  });
}

function fakeAI(handler) {
  const calls = [];
  return {
    calls,
    async run(model, params, options) {
      calls.push({ model, params, options });
      return handler(model, params, calls.length);
    },
  };
}

const t0 = Date.UTC(2026, 9, 12, 15, 0);
const msg = (id, role, text, extra = {}) => ({ id, role, kind: 'chat', text, attachments: [], createdAt: t0 + Number(id.slice(1)) * 1000, ...extra });

test('free model: streams OpenAI-style chunks, turns thinking off, sends fresh photos, records usage', async () => {
  const store = fakeStore({
    messages: [
      msg('m1', 'user', 'hey', { attachments: ['old'] }),
      msg('m2', 'assistant', '[[mood:warm]] hi!'),
      msg('m3', 'user', 'look at this', { attachments: ['img'] }),
    ],
    attachments: {
      old: { id: 'old', name: 'old.jpg', kind: 'image', mime: 'image/jpeg' },
      img: { id: 'img', name: 'room.jpg', kind: 'image', mime: 'image/jpeg' },
    },
    files: { old: 'T0xE', img: 'TkVX' },
  });
  const AI = fakeAI(() =>
    sse([
      { choices: [{ delta: { content: '[[mood:curious]] cozy ' } }] },
      { choices: [{ delta: { content: 'room!' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3000, completion_tokens: 250 } },
      '[DONE]',
    ]),
  );
  const ai = createAI({ AI }, store);
  assert.equal(ai.provider, 'workers-ai');
  assert.equal(ai.model, DEFAULT_WORKERS_MODEL);

  const deltas = [];
  const { raw, risk } = await ai.reply(state(), (t) => deltas.push(t));
  assert.equal(raw, '[[mood:curious]] cozy room!');
  assert.equal(deltas.join(''), raw);
  assert.equal(risk, false);

  const { model, params } = AI.calls[0];
  assert.equal(model, '@cf/google/gemma-4-26b-a4b-it');
  assert.deepEqual(params.chat_template_kwargs, { enable_thinking: false });
  assert.equal(params.stream, true);
  assert.ok(params.max_completion_tokens > 0);
  assert.equal(params.messages[0].role, 'system');
  assert.match(params.messages[0].content, /Format reminders/);
  // The new photo is sent as a data URI; the old one is only mentioned.
  const json = JSON.stringify(params.messages);
  assert.ok(json.includes('data:image/jpeg;base64,TkVX'));
  assert.ok(!json.includes('T0xE'));
  assert.ok(json.includes('[They sent a photo: old.jpg]'));
  // 3000 * 9091/1e6 + 250 * 27273/1e6 ≈ 34.1 neurons
  assert.equal((await ai.usageToday()).neurons, 34);
});

test('legacy-format models stream {response} chunks and get max_tokens', async () => {
  const store = fakeStore({ messages: [msg('m1', 'user', 'hello')] });
  const AI = fakeAI(() => sse([{ response: '[[mood:warm]] hey ' }, { response: 'there' }, { response: '', usage: { prompt_tokens: 10, completion_tokens: 2 } }, '[DONE]']));
  const ai = createAI({ AI, AI_MODEL: '@cf/meta/llama-4-scout-17b-16e-instruct' }, store);
  const { raw } = await ai.reply(state(), () => {});
  assert.equal(raw, '[[mood:warm]] hey there');
  assert.ok(AI.calls[0].params.max_tokens >= 500);
  assert.equal(AI.calls[0].params.chat_template_kwargs, undefined);
});

test('crisis language adds the safety note even if the model would miss it', async () => {
  const store = fakeStore({ messages: [msg('m1', 'user', 'honestly I want to die')] });
  const AI = fakeAI(() => sse([{ choices: [{ delta: { content: '[[mood:concerned]] I hear you.' } }] }, '[DONE]']));
  const { risk } = await createAI({ AI }, store).reply(state(), () => {});
  assert.equal(risk, true);
  assert.ok(JSON.stringify(AI.calls[0].params.messages.at(-1)).includes(CRISIS_NOTE.slice(0, 40)));
});

test('a busy model falls back once; a spent free allowance becomes a friendly message', async () => {
  const store = fakeStore({ messages: [msg('m1', 'user', 'hi')] });
  const AI = fakeAI((model) => {
    if (model.includes('gemma')) throw new Error('3040: Capacity temporarily exceeded, please try again.');
    return sse([{ response: '[[mood:warm]] hi from scout' }, '[DONE]']);
  });
  const { raw } = await createAI({ AI }, store).reply(state(), () => {});
  assert.equal(raw, '[[mood:warm]] hi from scout');
  // The first try says "busy" right away instead of queueing; the fallback is allowed to wait.
  assert.deepEqual(AI.calls[0].options, { rejectIfBusy: true });
  assert.equal(AI.calls[1].model, '@cf/meta/llama-4-scout-17b-16e-instruct');
  assert.equal(AI.calls[1].options, undefined);

  const quota = fakeAI(() => {
    throw new Error("4006: AiError: AiError: you have used up your daily free allocation of 10,000 neurons, please upgrade to Cloudflare's Workers Paid plan.");
  });
  const ai = createAI({ AI: quota }, store);
  await assert.rejects(ai.reply(state(), () => {}), (err) => /recharged/.test(friendlyMessage(err, 'America/New_York')));
  // Check-ins still go out, from a simple template.
  const text = await ai.checkin(state());
  assert.match(text, /^\[\[mood:/);
});

test('memory notes update from the free model and the window advances', async () => {
  const messages = Array.from({ length: 50 }, (_, i) => msg(`m${i + 1}`, i % 2 ? 'assistant' : 'user', `message ${i + 1}`));
  const store = fakeStore({ messages });
  const AI = fakeAI(() => ({ choices: [{ message: { content: '- Name: Sam\n- Stressed about exams' } }], usage: { prompt_tokens: 900, completion_tokens: 30 } }));
  const s = state();
  await createAI({ AI }, store).maybeUpdateMemory(s);
  assert.equal(s.memory.text, '- Name: Sam\n- Stressed about exams');
  assert.equal(s.memory.coveredUntil, messages.at(-1).createdAt);
  assert.equal(AI.calls[0].params.stream, false);
  // 50 messages > 40: keep the newest 20 verbatim
  assert.equal(s.historyStart, messages[30].createdAt);
  assert.deepEqual(store.saved.at(-1), ['memory', 'meta']);
});

test('photos: only fresh ones, at most 4, loaded in one query; documents trimmed with a shared budget', async () => {
  const photos = Array.from({ length: 6 }, (_, i) => `p${i}`);
  const attachments = Object.fromEntries(photos.map((id) => [id, { id, name: `${id}.jpg`, kind: 'image', mime: 'image/jpeg' }]));
  attachments.d1 = { id: 'd1', name: 'journal.pdf', kind: 'pdf', mime: 'application/pdf', text: 'a'.repeat(30000) };
  attachments.d2 = { id: 'd2', name: 'notes.txt', kind: 'text', mime: 'text/plain', text: 'b'.repeat(30000) };
  attachments.old = { id: 'old', name: 'old.txt', kind: 'text', mime: 'text/plain', text: 'c'.repeat(30000) };
  const store = fakeStore({
    messages: [
      msg('m1', 'user', 'my old notes', { attachments: ['old'] }),
      msg('m2', 'assistant', '[[mood:warm]] got them'),
      msg('m3', 'user', 'six photos and two docs', { attachments: [...photos, 'd1', 'd2'] }),
    ],
    attachments,
    files: Object.fromEntries(photos.map((id) => [id, `DATA${id}`])),
  });
  const AI = fakeAI(() => sse([{ choices: [{ delta: { content: '[[mood:warm]] ok' } }] }, '[DONE]']));
  await createAI({ AI }, store).reply(state(), () => {});
  const json = JSON.stringify(AI.calls[0].params.messages);
  for (const id of photos.slice(0, 4)) assert.ok(json.includes(`base64,DATA${id}`), id);
  for (const id of photos.slice(4)) {
    assert.ok(!json.includes(`DATA${id}`));
    assert.ok(json.includes(`They sent a photo: ${id}.jpg. You can look at 4 photos at a time`));
  }
  // 40,000 characters shared by the two new documents; 12,000 for the older one.
  assert.ok(json.includes('a'.repeat(20000)) && !json.includes('a'.repeat(20001)));
  assert.ok(json.includes('b'.repeat(20000)) && !json.includes('b'.repeat(20001)));
  assert.ok(json.includes('c'.repeat(12000)) && !json.includes('c'.repeat(12001)));
  assert.equal(store.queries.filter((q) => q.fileData).length, 1);
  assert.deepEqual(store.queries.find((q) => q.fileData).fileData, photos.slice(0, 4));
});

test('Claude on the Worker: photos and PDFs in full only while new, older PDFs as their text', async () => {
  const store = fakeStore({
    messages: [
      msg('m1', 'user', 'old stuff', { attachments: ['img1', 'pdf1'] }),
      msg('m2', 'assistant', '[[mood:warm]] thanks'),
      msg('m3', 'user', 'new stuff', { attachments: ['img2', 'pdf2'] }),
    ],
    attachments: {
      img1: { id: 'img1', name: 'a.jpg', kind: 'image', mime: 'image/jpeg' },
      img2: { id: 'img2', name: 'b.jpg', kind: 'image', mime: 'image/jpeg' },
      pdf1: { id: 'pdf1', name: 'old.pdf', kind: 'pdf', mime: 'application/pdf', text: 'old pdf text' },
      pdf2: { id: 'pdf2', name: 'new.pdf', kind: 'pdf', mime: 'application/pdf', text: 'new pdf text' },
    },
    files: { img1: 'IMG1', img2: 'IMG2', pdf1: 'PDF1', pdf2: 'PDF2' },
  });
  const ai = createAI({ ANTHROPIC_API_KEY: 'test' }, store);
  let body;
  globalThis.__fetch ??= globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    body = JSON.parse(init.body);
    throw new Error('stop here');
  };
  try {
    await ai.reply(state(), () => {}).catch(() => {});
  } finally {
    globalThis.fetch = globalThis.__fetch;
  }
  const json = JSON.stringify(body.messages);
  assert.ok(json.includes('IMG2') && json.includes('PDF2'));
  assert.ok(!json.includes('IMG1') && !json.includes('PDF1'));
  assert.ok(json.includes('They sent a photo: a.jpg') && json.includes('old pdf text'));
  assert.deepEqual(store.queries.find((q) => q.fileData).fileData, ['img2', 'pdf2']);
});

test('memory notes cut off at the token limit keep the old notes; a broken usage meter never loses a reply', async () => {
  const messages = Array.from({ length: 14 }, (_, i) => msg(`m${i + 1}`, i % 2 ? 'assistant' : 'user', `message ${i + 1}`));
  const store = fakeStore({ messages });
  const AI = fakeAI(() => ({ choices: [{ message: { content: '- Name: Sam\n- Likes hik' }, finish_reason: 'length' }] }));
  const s = state();
  s.memory.text = '- Name: Sam';
  await createAI({ AI }, store).maybeUpdateMemory(s);
  assert.equal(s.memory.text, '- Name: Sam');
  assert.equal(store.saved.length, 0);

  const chat = fakeStore({ messages: [msg('m1', 'user', 'hi')] });
  chat.addUsage = async () => {
    throw new Error('D1_ERROR: transient');
  };
  const streaming = fakeAI(() => sse([{ choices: [{ delta: { content: '[[mood:warm]] hey!' } }], usage: { prompt_tokens: 10, completion_tokens: 3 } }, '[DONE]']));
  const { raw } = await createAI({ AI: streaming }, chat).reply(state(), () => {});
  assert.equal(raw, '[[mood:warm]] hey!');
});
