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
    async attachmentMap(ids) {
      return Object.fromEntries(ids.filter((id) => attachments[id]).map((id) => [id, attachments[id]]));
    },
    async fileData(id) {
      return files[id] ?? null;
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
    async run(model, params) {
      calls.push({ model, params });
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
  assert.equal(AI.calls[1].model, '@cf/meta/llama-4-scout-17b-16e-instruct');

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
