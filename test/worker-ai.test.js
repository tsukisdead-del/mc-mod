// The Cloudflare version's AI (worker/ai.js) with a fake Workers AI binding, over the real storage code
// (worker/store.js on Node's built-in SQLite, see helpers/d1.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAI, friendlyMessage, DEFAULT_WORKERS_MODEL } from '../worker/ai.js';
import { defaultSettings } from '../server/settings.js';
import { CRISIS_NOTE } from '../server/safety.js';
import { chunkText, charsPerToken } from '../server/doc-search.js';
import { newStore, skipWithoutSqlite as skip } from './helpers/d1.js';

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

const okStream =
  (text = '[[mood:warm]] ok') =>
  () =>
    sse([{ choices: [{ delta: { content: text } }] }, '[DONE]']);

async function photo(store, name, data) {
  return (await store.saveAttachment({ name, kind: 'image', mime: 'image/jpeg', size: 3 }, data)).id;
}

async function doc(store, name, text, { kind = 'text', base64 = null, pages } = {}) {
  const mime = kind === 'pdf' ? 'application/pdf' : 'text/plain';
  const parts = chunkText(text);
  return (
    await store.saveAttachment({ name, kind, mime, size: text.length }, base64, {
      text,
      parts,
      tokens: Math.ceil(text.length / charsPerToken(text)),
      pages,
    })
  ).id;
}

const say = (store, role, text, attachments = []) => store.addMessage({ role, text, attachments });
const sent = (AI, i = 0) => JSON.stringify(AI.calls[i].params.messages);

test('free model: streams OpenAI-style chunks, turns thinking off, sends fresh photos, records usage', { skip }, async () => {
  const { store } = await newStore();
  await say(store, 'user', 'hey', [await photo(store, 'old.jpg', 'T0xE')]);
  await say(store, 'assistant', '[[mood:warm]] hi!');
  await say(store, 'user', 'look at this', [await photo(store, 'room.jpg', 'TkVX')]);
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
  const json = sent(AI);
  assert.ok(json.includes('data:image/jpeg;base64,TkVX'));
  assert.ok(!json.includes('T0xE'));
  assert.ok(json.includes('[They sent a photo: old.jpg]'));
  // 3000 * 9091/1e6 + 250 * 27273/1e6 ≈ 34.1 neurons
  assert.equal((await ai.usageToday()).neurons, 34);
});

test('legacy-format models stream {response} chunks and get max_tokens', { skip }, async () => {
  const { store } = await newStore();
  await say(store, 'user', 'hello');
  const AI = fakeAI(() =>
    sse([{ response: '[[mood:warm]] hey ' }, { response: 'there' }, { response: '', usage: { prompt_tokens: 10, completion_tokens: 2 } }, '[DONE]']),
  );
  const ai = createAI({ AI, AI_MODEL: '@cf/meta/llama-4-scout-17b-16e-instruct' }, store);
  const { raw } = await ai.reply(state(), () => {});
  assert.equal(raw, '[[mood:warm]] hey there');
  assert.ok(AI.calls[0].params.max_tokens >= 500);
  assert.equal(AI.calls[0].params.chat_template_kwargs, undefined);
});

test('crisis language adds the safety note even if the model would miss it', { skip }, async () => {
  const { store } = await newStore();
  await say(store, 'user', 'honestly I want to die');
  const AI = fakeAI(okStream('[[mood:concerned]] I hear you.'));
  const { risk } = await createAI({ AI }, store).reply(state(), () => {});
  assert.equal(risk, true);
  assert.ok(JSON.stringify(AI.calls[0].params.messages.at(-1)).includes(CRISIS_NOTE.slice(0, 40)));
});

test('a busy model falls back once; a spent free allowance becomes a friendly message', { skip }, async () => {
  const { store } = await newStore();
  await say(store, 'user', 'hi');
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
    throw new Error(
      "4006: AiError: AiError: you have used up your daily free allocation of 10,000 neurons, please upgrade to Cloudflare's Workers Paid plan.",
    );
  });
  const ai = createAI({ AI: quota }, store);
  await assert.rejects(
    ai.reply(state(), () => {}),
    (err) => /recharged/.test(friendlyMessage(err, 'America/New_York')),
  );
  // Check-ins still go out, from a simple template.
  const text = await ai.checkin(state());
  assert.match(text, /^\[\[mood:/);
});

test('memory notes update from the free model and the window advances', { skip }, async () => {
  const { store } = await newStore();
  const messages = [];
  for (let i = 0; i < 50; i++) messages.push(await say(store, i % 2 ? 'assistant' : 'user', `message ${i + 1}`));
  const AI = fakeAI(() => ({
    choices: [{ message: { content: '- Name: Sam\n- Stressed about exams' } }],
    usage: { prompt_tokens: 900, completion_tokens: 30 },
  }));
  const s = state();
  await createAI({ AI }, store).maybeUpdateMemory(s);
  assert.equal(s.memory.text, '- Name: Sam\n- Stressed about exams');
  assert.equal(s.memory.coveredUntil, messages.at(-1).createdAt);
  assert.equal(AI.calls[0].params.stream, false);
  // 50 messages > 40: keep the newest 20 verbatim
  assert.equal(s.historyStart, messages[30].createdAt);
});

test('photos: only fresh ones, at most 4, in one query; short documents go in whole', { skip }, async () => {
  const { store, d1 } = await newStore();
  const photos = [];
  for (let i = 0; i < 6; i++) photos.push(await photo(store, `p${i}.jpg`, `DATA${i}`));
  const notes = await doc(store, 'notes.txt', 'I keep thinking about the argument with my sister. '.repeat(20));
  await say(store, 'user', 'six photos and my notes', [...photos, notes]);
  const AI = fakeAI(okStream());
  const before = d1.queries;
  await createAI({ AI }, store).reply(state(), () => {});
  const json = sent(AI);
  for (const i of [0, 1, 2, 3]) assert.ok(json.includes(`base64,DATA${i}`), `photo ${i}`);
  for (const i of [4, 5]) {
    assert.ok(!json.includes(`DATA${i}`));
    assert.ok(json.includes(`They sent a photo: p${i}.jpg. You can look at 4 photos at a time`));
  }
  assert.ok(json.includes('[Document they sent: \\"notes.txt\\"]'));
  assert.equal(json.split('argument with my sister').length - 1, 20);
  // The whole reply (history, files, usage) stays far below D1's 50 queries per request.
  assert.ok(d1.queries - before <= 12, `queries: ${d1.queries - before}`);
});

// A long "book": ordinary paragraphs with one distinctive passage near the end.
function book(passage, at = 700, count = 900) {
  return Array.from({ length: count }, (_, i) => (i === at ? passage : `Paragraph ${i}: the morning was quiet and the street was empty again.`)).join(
    '\n\n',
  );
}

test('a long document: its opening and the parts that match what they asked, not the whole thing', { skip }, async () => {
  const { store } = await newStore();
  const text = book('At the lighthouse, Marguerite finally forgave her brother for the fire.');
  const id = await doc(store, 'novel.txt', text);
  await say(store, 'user', 'can you help me understand why Marguerite forgave her brother?', [id]);
  const AI = fakeAI(okStream());
  await createAI({ AI }, store).reply(state(), () => {});
  const msgs = AI.calls[0].params.messages;
  const json = JSON.stringify(msgs);
  assert.ok(json.includes('Long document they sent: \\"novel.txt\\"'), 'overview');
  assert.ok(json.includes('Paragraph 0: the morning'), 'opening');
  assert.ok(json.includes('Marguerite finally forgave her brother'), 'matching part');
  assert.ok(json.length < 40000, `sent ${json.length} chars, the book is ${text.length}`);
  // The matching parts ride on the newest message.
  assert.match(msgs.at(-1).content, /Parts of "novel.txt"[\s\S]*Marguerite finally forgave/);
});

test('a long document sent without a question gets evenly spaced samples', { skip }, async () => {
  const { store } = await newStore();
  const id = await doc(store, 'novel.txt', book('nothing special here'));
  await say(store, 'user', '', [id]);
  const AI = fakeAI(okStream());
  await createAI({ AI }, store).reply(state(), () => {});
  const last = AI.calls[0].params.messages.at(-1).content;
  assert.equal((last.match(/% of the way in ---/g) || []).length, 4);
});

test('a document from earlier in the chat is still searched when they bring it up', { skip }, async () => {
  const { store } = await newStore();
  const id = await doc(store, 'journal.txt', book('On the ferry to Naxos I felt calm for the first time in months.', 300, 400));
  await say(store, 'user', 'here is my journal', [id]);
  await say(store, 'assistant', '[[mood:warm]] thanks for sharing it');
  for (let i = 0; i < 5; i++) {
    await say(store, 'user', `ok ${i}`);
    await say(store, 'assistant', '[[mood:warm]] mm');
  }
  await say(store, 'user', 'remember the ferry to Naxos? why did I feel calm there');
  const AI = fakeAI(okStream());
  await createAI({ AI }, store).reply(state(), () => {});
  const msgs = AI.calls[0].params.messages;
  const json = JSON.stringify(msgs);
  // Too old to resend: only the name stays where it was sent...
  assert.ok(json.includes('[They sent a file: journal.txt]'));
  assert.ok(!json.includes('Paragraph 0: the morning'));
  // ...but the part they asked about comes back with their newest message.
  assert.match(msgs.at(-1).content, /a document they sent earlier[\s\S]*ferry to Naxos I felt calm/);
  // When they talk about something else, nothing from it is added.
  await say(store, 'assistant', '[[mood:warm]] mm');
  await say(store, 'user', 'anyway how are you');
  await createAI({ AI }, store).reply(state(), () => {});
  assert.ok(!sent(AI, 1).includes('Paragraph'));
});

test('Claude on the Worker: photos and small PDFs in full only while new, older PDFs as their text', { skip }, async () => {
  const { store } = await newStore();
  const img1 = await photo(store, 'a.jpg', 'IMG1');
  const pdf1 = await doc(store, 'old.pdf', 'old pdf text', { kind: 'pdf', base64: 'PDF1' });
  await say(store, 'user', 'old stuff', [img1, pdf1]);
  await say(store, 'assistant', '[[mood:warm]] thanks');
  const img2 = await photo(store, 'b.jpg', 'IMG2');
  const pdf2 = await doc(store, 'new.pdf', 'new pdf text', { kind: 'pdf', base64: 'PDF2' });
  await say(store, 'user', 'new stuff', [img2, pdf2]);
  const ai = createAI({ ANTHROPIC_API_KEY: 'test' }, store);
  let body;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    body = JSON.parse(init.body);
    throw new Error('stop here');
  };
  try {
    await ai.reply(state(), () => {}).catch(() => {});
  } finally {
    globalThis.fetch = realFetch;
  }
  const json = JSON.stringify(body.messages);
  assert.ok(json.includes('IMG2') && json.includes('PDF2'));
  assert.ok(!json.includes('IMG1') && !json.includes('PDF1'));
  assert.ok(json.includes('They sent a photo: a.jpg') && json.includes('old pdf text'));
});

test('memory notes cut off at the token limit keep the old notes; a broken usage meter never loses a reply', { skip }, async () => {
  const { store } = await newStore();
  for (let i = 0; i < 14; i++) await say(store, i % 2 ? 'assistant' : 'user', `message ${i + 1}`);
  const AI = fakeAI(() => ({ choices: [{ message: { content: '- Name: Sam\n- Likes hik' }, finish_reason: 'length' }] }));
  const s = state();
  s.memory.text = '- Name: Sam';
  await createAI({ AI }, store).maybeUpdateMemory(s);
  assert.equal(s.memory.text, '- Name: Sam');

  const chat = await newStore();
  await say(chat.store, 'user', 'hi');
  chat.store.addUsage = async () => {
    throw new Error('D1_ERROR: transient');
  };
  const streaming = fakeAI(() =>
    sse([{ choices: [{ delta: { content: '[[mood:warm]] hey!' } }], usage: { prompt_tokens: 10, completion_tokens: 3 } }, '[DONE]']),
  );
  const { raw } = await createAI({ AI: streaming }, chat.store).reply(state(), () => {});
  assert.equal(raw, '[[mood:warm]] hey!');
});
