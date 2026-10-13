// The AI for the Cloudflare version.
// - Default: Workers AI on the free plan (10,000 "neurons" a day, shared by the whole account). Gemma 4 handles
//   both chat and photos and fits roughly 250+ texts a day.
// - If an ANTHROPIC_API_KEY secret is set: Claude, exactly like the Node server (paid per use).
// - MOCK_AI=1: canned demo replies.
import Anthropic from '@anthropic-ai/sdk';
import { PERSONA, settingsBlock, checkinInstruction, MEMORY_INSTRUCTIONS } from '../server/prompts.js';
import { buildTurns, resolveFiles, appendUserNote, transcript, nextHistoryStart, MEMORY_EVERY } from '../server/history.js';
import { looksLikeCrisis, CRISIS_NOTE } from '../server/safety.js';
import { mockReplyText, mockCheckinText, mockMemoryText, streamMock } from '../server/mock.js';
import { filePlaceholder } from '../server/file-types.js';
import { DOC_BUDGETS, planDocuments, pickParts, queryTerms, ftsQuery, overviewText, excerptText, searchTextFor } from '../server/doc-search.js';
import { OPENING_CHARS } from './store.js';
import { FORMAT_REMINDER, simpleCheckin, readStream, textFromResult, finishFromResult, toChatMessages } from '../server/open-models.js';

// Workers AI models we know how to talk to. Rates are neurons per million tokens (from Cloudflare's pricing).
// "openai" models stream OpenAI-style chunks; "legacy" ones stream {response} chunks.
const WORKERS_MODELS = {
  '@cf/google/gemma-4-26b-a4b-it': { format: 'openai', vision: true, thinking: true, input: 9091, output: 27273 },
  '@cf/meta/llama-4-scout-17b-16e-instruct': { format: 'legacy', vision: true, input: 24545, output: 77273 },
  '@cf/mistralai/mistral-small-3.1-24b-instruct': { format: 'legacy', vision: false, input: 31876, output: 50488 },
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast': { format: 'legacy', vision: false, input: 26668, output: 204805 },
};
export const DEFAULT_WORKERS_MODEL = '@cf/google/gemma-4-26b-a4b-it';
const MODEL_LABELS = {
  '@cf/google/gemma-4-26b-a4b-it': 'Gemma 4 by Google',
  '@cf/meta/llama-4-scout-17b-16e-instruct': 'Llama 4 Scout by Meta',
  '@cf/mistralai/mistral-small-3.1-24b-instruct': 'Mistral Small 3.1',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast': 'Llama 3.3 70B by Meta',
};
const FALLBACK_WORKERS_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';
const WHISPER = '@cf/openai/whisper-large-v3-turbo';
const WHISPER_NEURONS_PER_MINUTE = 46.63;
export const FREE_NEURONS_PER_DAY = 10000;

// The free plan's budget is tight (10,000 neurons a day, 10 ms of CPU per request), so the free model sees a
// shorter verbatim history (the memory notes carry the rest). On both providers, photos and PDFs go in full only
// on the turn they're sent. Documents go in whole when they're short and recent; long ones (and older ones) are
// searched, and only their opening plus the parts that match what they said are sent (see doc-search.js).
const FREE_WINDOW = { max: 40, keep: 20 };
const RECENT_DOC_MESSAGES = 6;
const MAX_PHOTOS = { free: 4, claude: 6 };
// PDFs this small keep their original in D1 (worker/files.js), so Claude can see their pages.
const STORED_PDF_BYTES = 1_400_000;
// Rough prompt-token cost of one photo, for the usage meter when the model doesn't report usage.
const PHOTO_TOKENS = 300;

const REFUSAL_REPLY =
  "[[mood:concerned]] I'm not able to respond to that one, sorry.\n|||\nI'm still here though. Want to tell me what's going on in a different way?";
const EMPTY_REPLY = '[[mood:thinking]] Sorry, my brain glitched for a second. Can you say that again?';

export class QuotaError extends Error {}

// ---------- errors ----------

function utcMidnightLocal(timezone) {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  try {
    return new Date(next).toLocaleTimeString('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit' });
  } catch {
    return 'midnight UTC';
  }
}

export function isQuotaError(err) {
  return err instanceof QuotaError || /\b(3036|4006)\b|daily free allocation/i.test(String(err?.message || ''));
}

export function friendlyMessage(err, timezone = 'UTC') {
  const msg = String(err?.message || '');
  if (isQuotaError(err)) {
    return `I've used up today's free thinking time 😴 I'll be fully recharged at ${utcMidnightLocal(timezone)} your time. (The free AI resets every day at midnight UTC.)`;
  }
  if (/\b3040\b|capacity temporarily exceeded/i.test(msg)) return 'Lots of people are talking to the free AI right now. Try again in a minute?';
  if (/\b300[78]\b|request timeout/i.test(msg)) return 'The free AI is running slow right now. Try again in a minute?';
  if (/\b5035\b|requires (a )?Workers Paid/i.test(msg))
    return 'That AI model needs a paid Cloudflare plan. Remove the AI_MODEL setting to use the free one.';
  if (/\b5016\b/.test(msg)) return 'That AI model needs its license accepted first. Remove the AI_MODEL setting to use the default one.';
  if (err instanceof Anthropic.AuthenticationError) return "The Claude API key isn't working. Double-check the ANTHROPIC_API_KEY secret.";
  if (err instanceof Anthropic.RateLimitError) return "I'm getting a lot of messages at once. Give it a minute and try again.";
  if (err instanceof Anthropic.BadRequestError) return "Something about that message didn't work (a file might be too big). Try again without it?";
  if (err instanceof Anthropic.APIConnectionError) return "I can't reach my brain right now (network issue). Try again in a moment.";
  return 'Something went wrong on my end. Try again?';
}

// ---------- Workers AI helpers ----------

function modelInfo(model) {
  return WORKERS_MODELS[model] || { format: 'openai', vision: false, input: 30000, output: 100000 };
}

function utcDay(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

function workersParams(model, messages, { stream, maxTokens }) {
  const info = modelInfo(model);
  const params = { messages, stream, temperature: 0.7 };
  if (info.format === 'openai') {
    params.max_completion_tokens = maxTokens;
    if (stream) params.stream_options = { include_usage: true };
    // Hidden "thinking" would spend free neurons on every reply.
    if (info.thinking) params.chat_template_kwargs = { enable_thinking: false };
  } else {
    params.max_tokens = maxTokens; // legacy models default to just 256
  }
  return params;
}

// ---------- the provider ----------

export function createAI(env, store) {
  const provider = env.MOCK_AI === '1' ? 'mock' : env.ANTHROPIC_API_KEY ? 'anthropic' : 'workers-ai';
  const model =
    provider === 'anthropic' ? env.CLAUDE_MODEL || 'claude-opus-5-5' : provider === 'workers-ai' ? env.AI_MODEL || DEFAULT_WORKERS_MODEL : 'demo';
  const info = modelInfo(model);
  const free = provider === 'workers-ai';
  let claude = null;

  // ----- usage ledger (free plan) -----

  // Best effort: a hiccup in the usage meter must never lose a reply.
  async function recordNeurons(neurons) {
    if (!free || !neurons) return;
    try {
      await store.addUsage(utcDay(), Math.round(neurons * 10) / 10);
    } catch (err) {
      console.error('Usage meter update failed:', err?.message || err);
    }
  }

  // Estimate from the text (and a flat amount per photo) only when the model doesn't report usage.
  function promptTokens(messages) {
    let chars = 0;
    let photos = 0;
    for (const m of messages) {
      if (typeof m.content === 'string') chars += m.content.length;
      else for (const p of m.content) p.type === 'text' ? (chars += p.text.length) : photos++;
    }
    return chars / 4 + photos * PHOTO_TOKENS;
  }

  function neuronsFor(m, usage, messages, outputText) {
    const i = modelInfo(m);
    const input = usage?.prompt_tokens ?? promptTokens(messages);
    const output = usage?.completion_tokens ?? outputText.length / 4;
    return (input * i.input + output * i.output) / 1e6;
  }

  async function usageToday() {
    const u = await store.get('usage', null);
    return { neurons: u?.day === utcDay() ? Math.round(u.neurons) : 0, limit: FREE_NEURONS_PER_DAY };
  }

  // ----- conversation building -----

  // search: look in long documents for what their newest messages are about (replies do; check-ins don't).
  async function history(state, { search = false } = {}) {
    const messages = await store.messagesSince(state.historyStart);
    // Attachments of the messages still waiting for a reply ("fresh"): photos and PDFs are only sent then.
    let lastReply = -1;
    messages.forEach((m, i) => m.role === 'assistant' && (lastReply = i));
    const fresh = new Set(messages.slice(lastReply + 1).flatMap((m) => m.attachments || []));
    const metas = await store.attachmentMap(messages.flatMap((m) => m.attachments || []));
    const placeholder = (ids) => filePlaceholder((ids || []).map((id) => metas[id]));
    const turns = buildTurns(messages, { timezone: state.settings.timezone, filePlaceholder: placeholder, recentFiles: RECENT_DOC_MESSAGES });
    const files = await loadFiles(turns, metas, fresh, search ? searchTextFor(messages) : '');
    await resolveFiles(turns, (ids) => (provider === 'anthropic' ? claudeFiles(ids, files) : openFiles(ids, files)));
    // Matching parts of long documents go with their newest message, so earlier turns never change.
    if (files.excerpts.length && turns.at(-1)?.role === 'user') appendUserNote(turns, files.excerpts.join('\n\n'));
    return turns;
  }

  // Decides what each file in the conversation becomes and loads it, in about four queries run side by side.
  async function loadFiles(turns, metas, fresh, query) {
    const budget = free ? DOC_BUDGETS.free : DOC_BUDGETS.claude;
    const maxPhotos = free ? MAX_PHOTOS.free : MAX_PHOTOS.claude;
    const recentIds = turns.flatMap((t) => t.content.filter((p) => p.type === 'files').flatMap((p) => p.ids)).filter((id) => metas[id]);
    const recent = new Set(recentIds);
    const canSee = provider === 'anthropic' || info.vision;
    const photos = recentIds.filter((id) => metas[id].kind === 'image' && canSee && fresh.has(id)).slice(0, maxPhotos);
    // Claude reads a new, small PDF itself (pages and all); everything else is read as text.
    const native = new Set(
      provider === 'anthropic' ? recentIds.filter((id) => metas[id].kind === 'pdf' && fresh.has(id) && metas[id].size <= STORED_PDF_BYTES) : [],
    );
    // Recent documents as before; older ones in the conversation only to search them.
    const docs = Object.values(metas)
      .filter((m) => m.kind !== 'image' && !native.has(m.id) && (recent.has(m.id) || m.chunks > 0))
      .map((m) => ({
        id: m.id,
        meta: m,
        tokens: m.tokens ?? Math.ceil(m.chars / 3.5),
        cpt: m.tokens ? m.chars / m.tokens : 3.5,
        chunks: m.chunks,
        fresh: fresh.has(m.id),
        recent: recent.has(m.id),
      }));
    const plan = planDocuments(docs, budget);
    for (const d of docs) d.mode = plan.get(d.id);
    const inline = docs.filter((d) => d.mode === 'inline');
    const long = docs.filter((d) => d.mode === 'long');
    const searchable = docs.filter((d) => d.mode !== 'inline' && d.chunks > 0);
    const terms = query ? queryTerms(query) : [];
    const [data, texts, legacyTexts, openings, matches] = await Promise.all([
      store.fileData([...photos, ...native]),
      store.documentTexts(inline.filter((d) => d.chunks > 0).map((d) => d.id)),
      // Documents saved by older versions keep all their text with the attachment.
      store.attachmentMap(
        inline.filter((d) => !d.chunks).map((d) => d.id),
        { text: true },
      ),
      store.attachmentMap(
        long.map((d) => d.id),
        { text: OPENING_CHARS },
      ),
      terms.length && searchable.length
        ? store.searchDocuments(
            searchable.map((d) => d.id),
            ftsQuery(terms),
            budget.maxParts * 2,
          )
        : [],
    ]);
    for (const [id, m] of Object.entries(legacyTexts)) texts[id] = m.text || '';

    // Matching parts first, then samples for long documents that matched little.
    const picked = pickParts({ docs: searchable, matches, budget });
    const have = new Map(matches.map((m) => [`${m.docId}:${m.seq}`, m.text]));
    const missing = [...picked].flatMap(([id, seqs]) => seqs.filter((seq) => !have.has(`${id}:${seq}`)).map((seq) => [id, seq]));
    for (const p of await store.documentParts(missing)) have.set(`${p.docId}:${p.seq}`, p.text);
    const excerpts = searchable
      .filter((d) => picked.get(d.id)?.length)
      .sort((a, b) => Number(b.fresh) - Number(a.fresh))
      .map((d) =>
        excerptText({
          name: d.meta.name,
          pages: d.meta.pages,
          chars: d.meta.chars,
          chunks: d.chunks,
          older: d.mode === 'search',
          parts: picked.get(d.id).map((seq) => ({ seq, text: have.get(`${d.id}:${seq}`) || '' })),
        }),
      );
    const hidden = new Set(recentIds.filter((id) => metas[id].kind === 'image' && canSee && fresh.has(id) && !photos.includes(id)));
    return {
      metas,
      data,
      texts,
      openings: Object.fromEntries(long.map((d) => [d.id, (openings[d.id]?.text || '').slice(0, Math.floor(budget.overview * d.cpt))])),
      plan,
      excerpts,
      canSee,
      hidden,
      maxPhotos,
    };
  }

  function docText(id, f) {
    const m = f.metas[id];
    if (f.plan.get(id) === 'long') return overviewText({ name: m.name, pages: m.pages, chars: m.chars, opening: f.openings[id] || '' });
    return `[Document they sent: "${m.name}"]\n${f.texts[id] || ''}`;
  }

  function photoNote(m, f) {
    if (f.hidden.has(m.id)) {
      return `[They sent a photo: ${m.name}. You can look at ${f.maxPhotos} photos at a time, so you can't see this one; if it matters, ask them to send it again by itself.]`;
    }
    return `[They sent a photo: ${m.name}${f.canSee ? '' : " (you can't see photos, so ask them to describe it)"}]`;
  }

  function openFiles(ids, f) {
    const parts = [];
    for (const id of ids) {
      const m = f.metas[id];
      if (!m) continue;
      if (m.kind === 'image') {
        if (f.data[id]) parts.push({ type: 'image_url', image_url: { url: `data:${m.mime};base64,${f.data[id]}` } });
        else parts.push({ type: 'text', text: photoNote(m, f) });
      } else {
        parts.push({ type: 'text', text: docText(id, f) });
      }
    }
    return parts;
  }

  function claudeFiles(ids, f) {
    const blocks = [];
    for (const id of ids) {
      const m = f.metas[id];
      if (!m) continue;
      const data = f.data[id];
      if (m.kind === 'image')
        blocks.push(data ? { type: 'image', source: { type: 'base64', media_type: m.mime, data } } : { type: 'text', text: photoNote(m, f) });
      else if (m.kind === 'pdf' && data)
        blocks.push({ type: 'document', title: m.name, source: { type: 'base64', media_type: 'application/pdf', data } });
      else blocks.push({ type: 'text', text: docText(id, f) });
    }
    return blocks;
  }

  function systemText(state) {
    const base = `${PERSONA}\n\n${settingsBlock(state.settings, state.memory.text)}`;
    return free ? `${base}\n\n${FORMAT_REMINDER}` : base;
  }

  // ----- Claude -----

  function claudeClient() {
    claude ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    return claude;
  }

  function claudeParams(state, messages, { effort, maxTokens = 64000, system }) {
    const params = {
      model,
      max_tokens: maxTokens,
      system: system ?? [
        { type: 'text', text: PERSONA },
        { type: 'text', text: settingsBlock(state.settings, state.memory.text), cache_control: { type: 'ephemeral' } },
      ],
      messages,
      cache_control: { type: 'ephemeral' },
    };
    if (effort && effort !== 'none') params.output_config = { effort };
    if (env.CLAUDE_FALLBACKS !== 'off' && /^claude-(opus-5|sonnet-5-5|fable-5)/.test(model)) {
      params.betas = ['server-side-fallback-2026-07-01'];
      params.fallbacks = 'default';
    }
    return params;
  }

  function claudeText(message) {
    return message.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
  }

  // ----- Workers AI calls -----

  // Returns { text, finish } (finish 'length' means the reply was cut off at maxTokens).
  async function runWorkers(m, messages, { stream, maxTokens, onText, rejectIfBusy }) {
    if (!env.AI) throw new Error('The AI binding is missing. Check the "ai" section of wrangler.jsonc.');
    const params = workersParams(m, messages, { stream, maxTokens });
    const run = () => (rejectIfBusy ? env.AI.run(m, params, { rejectIfBusy: true }) : env.AI.run(m, params));
    if (stream) {
      const { text, usage, finish } = await readStream(await run(), onText);
      await recordNeurons(neuronsFor(m, usage, messages, text));
      return { text, finish };
    }
    const result = await run();
    const text = textFromResult(result);
    await recordNeurons(neuronsFor(m, result?.usage, messages, text));
    return { text, finish: finishFromResult(result) };
  }

  // When the default model is busy, try the fallback once (never after text has already streamed). The first
  // call asks Workers AI to say "busy" (3040) right away instead of waiting in its queue.
  async function runWithFallback(messages, opts) {
    let streamed = false;
    const onText = opts.onText ? (t) => ((streamed = true), opts.onText(t)) : undefined;
    const canFallBack = model !== FALLBACK_WORKERS_MODEL && !env.AI_MODEL;
    try {
      return await runWorkers(model, messages, { ...opts, onText, rejectIfBusy: canFallBack });
    } catch (err) {
      const busy = /\b3040\b|capacity temporarily exceeded/i.test(String(err?.message || ''));
      if (!busy || streamed || !canFallBack) throw err;
      const vision = modelInfo(FALLBACK_WORKERS_MODEL).vision;
      return runWorkers(FALLBACK_WORKERS_MODEL, vision ? messages : stripImages(messages), { ...opts, onText });
    }
  }

  function stripImages(messages) {
    return messages.map((m) =>
      Array.isArray(m.content) ? { ...m, content: m.content.map((p) => (p.type === 'image_url' ? { type: 'text', text: '[photo]' } : p)) } : m,
    );
  }

  // ---------- public API ----------

  return {
    provider,
    model,
    modelLabel: MODEL_LABELS[model] || model,
    canTranscribe: free || provider === 'mock' ? Boolean(env.AI) || provider === 'mock' : false,
    usageToday,

    // Returns { raw, reset, risk } like the Node server, plus `answers`: the time of the newest message it answers.
    async reply(state, onDelta) {
      const pending = await store.unansweredUserMessages();
      const risk = pending.some((m) => looksLikeCrisis(m.text));
      const answers = pending.at(-1)?.createdAt ?? null;
      if (provider === 'mock') {
        const raw = mockReplyText({
          lastUserText: pending.map((m) => m.text).join(' '),
          hasFiles: pending.some((m) => m.attachments?.length),
          tone: state.settings.tone,
        });
        await streamMock(raw, onDelta);
        return { raw, risk, answers };
      }
      const turns = await history(state, { search: true });
      if (turns.at(-1)?.role !== 'user') throw new Error('There is nothing new to reply to.');
      if (risk) appendUserNote(turns, CRISIS_NOTE);

      if (provider === 'anthropic') {
        const stream = claudeClient().beta.messages.stream(claudeParams(state, turns, { effort: env.CHAT_EFFORT || 'medium' }));
        stream.on('text', (t) => onDelta(t));
        const final = await stream.finalMessage();
        if (final.stop_reason === 'refusal') return { raw: REFUSAL_REPLY, reset: true, risk, answers };
        return { raw: claudeText(final) || EMPTY_REPLY, risk, answers };
      }

      const { text } = await runWithFallback(toChatMessages(systemText(state), turns), { stream: true, maxTokens: 700, onText: onDelta });
      return { raw: text.trim() || EMPTY_REPLY, risk, answers };
    },

    // A check-in text, or a simple template when the free allowance is used up.
    async checkin(state) {
      if (provider === 'mock') return mockCheckinText();
      const note = checkinInstruction(state.settings, {
        now: Date.now(),
        lastUserAt: state.lastUserMessageAt,
        hasHistory: Boolean(state.memory.text) || Boolean(await store.lastMessage()),
        unanswered: state.checkin.unanswered,
      });
      const turns = appendUserNote(await history(state), note);
      try {
        if (provider === 'anthropic') {
          const final = await claudeClient()
            .beta.messages.stream(claudeParams(state, turns, { effort: 'low', maxTokens: 16000 }))
            .finalMessage();
          return final.stop_reason === 'refusal' ? null : claudeText(final) || null;
        }
        return (await runWithFallback(toChatMessages(systemText(state), turns), { stream: false, maxTokens: 300 })).text.trim() || null;
      } catch (err) {
        if (isQuotaError(err)) return simpleCheckin();
        throw err;
      }
    },

    // Refresh the long-term notes every MEMORY_EVERY messages (or now, when forced). Mutates and saves state.
    async maybeUpdateMemory(state, { force = false } = {}) {
      const pending = (await store.messagesSince(state.memory.coveredUntil + 1)).filter((m) => m.createdAt > state.memory.coveredUntil);
      if (!pending.length || (!force && pending.length < MEMORY_EVERY)) return;
      let notes;
      if (provider === 'mock') {
        notes = mockMemoryText(state.memory.text, pending);
      } else {
        const metas = await store.attachmentMap(pending.flatMap((m) => m.attachments || []));
        const convo = transcript(pending, {
          timezone: state.settings.timezone,
          therapistName: state.settings.therapistName,
          filePlaceholder: (ids) => filePlaceholder((ids || []).map((id) => metas[id])),
        });
        const prompt = `Current notes:\n${state.memory.text || '(none yet)'}\n\nNewest conversation:\n${convo}`;
        if (provider === 'anthropic') {
          const final = await claudeClient()
            .beta.messages.stream(
              claudeParams(state, [{ role: 'user', content: prompt }], { effort: 'low', maxTokens: 16000, system: MEMORY_INSTRUCTIONS }),
            )
            .finalMessage();
          if (final.stop_reason === 'refusal') return;
          notes = claudeText(final);
        } else {
          const { text, finish } = await runWithFallback(
            [
              { role: 'system', content: MEMORY_INSTRUCTIONS },
              { role: 'user', content: prompt },
            ],
            { stream: false, maxTokens: 600 },
          );
          // Cut off mid-note: keep the old notes rather than lose their tail; it tries again later.
          if (finish === 'length') {
            console.error('Memory notes came back cut off; keeping the old ones.');
            return;
          }
          notes = text.trim();
        }
      }
      if (!notes) return;
      state.memory = { text: notes, updatedAt: Date.now(), coveredUntil: pending[pending.length - 1].createdAt };
      const all = await store.messagesSince(state.historyStart);
      state.historyStart = nextHistoryStart(all, state.historyStart, state.memory.coveredUntil, free ? FREE_WINDOW : undefined);
      await store.saveState(state, ['memory', 'meta']);
    },

    // Speech to text (16 kHz WAV from the browser) with Whisper on Workers AI.
    async transcribe(audio, contentType) {
      if (provider === 'mock') return 'I feel kind of stressed about school';
      const { Buffer } = await import('node:buffer');
      const result = await env.AI.run(WHISPER, { audio: Buffer.from(audio).toString('base64'), vad_filter: true });
      // WAV at 16 kHz mono, 16-bit: 32,000 bytes per second.
      const minutes = /wav/i.test(contentType) ? audio.byteLength / 32000 / 60 : 0.5;
      await recordNeurons(minutes * WHISPER_NEURONS_PER_MINUTE);
      return String(result?.text || '').trim();
    },
  };
}
