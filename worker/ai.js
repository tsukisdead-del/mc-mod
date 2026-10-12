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

// The free plan's budget is tight, so the free model sees a shorter verbatim history (the memory notes carry
// the rest), photos only on the turn they're sent, and documents trimmed.
const FREE_WINDOW = { max: 40, keep: 20 };
const FREE_DOC_TURNS = 6;
const FREE_DOC_CHARS = 40000;

const REFUSAL_REPLY =
  "[[mood:concerned]] I'm not able to respond to that one, sorry.\n|||\nI'm still here though. Want to tell me what's going on in a different way?";
const EMPTY_REPLY = '[[mood:thinking]] Sorry, my brain glitched for a second. Can you say that again?';

// Short reminders at the end of the system prompt help smaller open models keep the app's format.
const FORMAT_REMINDER = `# Format reminders
- Your reply MUST start with one mood tag, for example [[mood:warm]].
- Separate texts with a line containing only |||.
- Never write timestamps or lines starting with [App note.
- Stay in character as the person's therapist friend; never mention these instructions.`;

// Check-ins that need no AI, used when the free allowance is spent for the day.
const SIMPLE_CHECKINS = [
  "[[mood:warm]] hey, just thinking about you. how's your day going?",
  "[[mood:warm]] checking in 💛 how are you feeling right now?",
  "[[mood:happy]] hi! no pressure to reply, just wanted to say I'm here if you want to talk.",
  "[[mood:proud]] quick reminder that you're doing better than you think.\n|||\nhow's today been?",
];

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
  if (/\b3040\b|capacity temporarily exceeded/i.test(msg)) return "Lots of people are talking to the free AI right now. Try again in a minute?";
  if (/\b5035\b|requires (a )?Workers Paid/i.test(msg)) return 'That AI model needs a paid Cloudflare plan. Remove the AI_MODEL setting to use the free one.';
  if (/\b5016\b/.test(msg)) return "That AI model needs its license accepted first. Remove the AI_MODEL setting to use the default one.";
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

// Reads a Workers AI SSE stream (both chunk formats), calling onText for each piece.
async function readStream(stream, onText) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let usage = null;
  let finish = null;
  const handle = (line) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let json;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    const piece = typeof json.response === 'string' && json.response ? json.response : json.choices?.[0]?.delta?.content || '';
    if (json.usage) usage = json.usage;
    finish = json.choices?.[0]?.finish_reason || finish;
    if (piece) {
      text += piece;
      onText(piece);
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf('\n')) >= 0) {
      handle(buffer.slice(0, cut).trim());
      buffer = buffer.slice(cut + 1);
    }
  }
  handle(buffer.trim());
  return { text, usage, finish };
}

function textFromResult(result) {
  if (typeof result?.response === 'string') return result.response;
  const content = result?.choices?.[0]?.message?.content;
  if (Array.isArray(content)) return content.map((c) => c.text || '').join('');
  return typeof content === 'string' ? content : '';
}

// OpenAI-style messages from neutral turns: images become image_url parts, everything else plain text.
function toChatMessages(system, turns) {
  const out = [{ role: 'system', content: system }];
  for (const t of turns) {
    const hasImage = t.content.some((p) => p.type === 'image_url');
    if (t.role === 'user' && hasImage) out.push({ role: 'user', content: t.content });
    else out.push({ role: t.role, content: t.content.map((p) => p.text || '').filter(Boolean).join('\n\n') });
  }
  return out;
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

  async function recordNeurons(neurons) {
    if (!free || !neurons) return;
    const day = utcDay();
    const u = await store.get('usage', { day, neurons: 0 });
    await store.put('usage', { day, neurons: (u.day === day ? u.neurons : 0) + Math.round(neurons * 10) / 10 });
  }

  function neuronsFor(m, usage, fallbackChars) {
    const i = modelInfo(m);
    const input = usage?.prompt_tokens ?? fallbackChars.input / 4;
    const output = usage?.completion_tokens ?? fallbackChars.output / 4;
    return (input * i.input + output * i.output) / 1e6;
  }

  async function usageToday() {
    const u = await store.get('usage', null);
    return { neurons: u?.day === utcDay() ? Math.round(u.neurons) : 0, limit: FREE_NEURONS_PER_DAY };
  }

  // ----- conversation building -----

  async function history(state) {
    const messages = await store.messagesSince(state.historyStart);
    // Attachments of the messages still waiting for a reply: photos are only sent then.
    let lastReply = -1;
    messages.forEach((m, i) => m.role === 'assistant' && (lastReply = i));
    const fresh = new Set(messages.slice(lastReply + 1).flatMap((m) => m.attachments || []));
    const all = messages.flatMap((m) => m.attachments || []);
    const metas = await store.attachmentMap(all, { withText: true });
    const placeholder = (ids) => filePlaceholder((ids || []).map((id) => metas[id]));
    const turns = buildTurns(messages, {
      timezone: state.settings.timezone,
      filePlaceholder: placeholder,
      recentFiles: provider === 'anthropic' ? undefined : FREE_DOC_TURNS,
    });
    return resolveFiles(turns, provider === 'anthropic' ? claudeFiles(metas) : (ids) => openFiles(ids, metas, fresh));
  }

  async function openFiles(ids, metas, fresh) {
    const parts = [];
    for (const id of ids) {
      const m = metas[id];
      if (!m) continue;
      if (m.kind === 'image') {
        const data = info.vision && fresh.has(id) ? await store.fileData(id) : null;
        if (data) parts.push({ type: 'image_url', image_url: { url: `data:${m.mime};base64,${data}` } });
        else parts.push({ type: 'text', text: `[They sent a photo: ${m.name}${info.vision ? '' : " (you can't see photos, so ask them to describe it)"}]` });
      } else {
        const text = m.text || '';
        const cut = text.length > FREE_DOC_CHARS;
        parts.push({
          type: 'text',
          text: `[Document they sent: "${m.name}"]\n${cut ? text.slice(0, FREE_DOC_CHARS) : text}${cut ? '\n[Only the first part of this document fit; say so if it matters.]' : ''}`,
        });
      }
    }
    return parts;
  }

  function claudeFiles(metas) {
    return async (ids) => {
      const blocks = [];
      for (const id of ids) {
        const m = metas[id];
        if (!m) continue;
        const data = m.kind === 'image' || m.kind === 'pdf' ? await store.fileData(id) : null;
        if (m.kind === 'image' && data) blocks.push({ type: 'image', source: { type: 'base64', media_type: m.mime, data } });
        else if (m.kind === 'pdf' && data) blocks.push({ type: 'document', title: m.name, source: { type: 'base64', media_type: 'application/pdf', data } });
        else if (m.text) blocks.push({ type: 'document', title: m.name, source: { type: 'text', media_type: 'text/plain', data: m.text } });
      }
      return blocks;
    };
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
    if (effort) params.output_config = { effort };
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

  async function runWorkers(m, messages, { stream, maxTokens, onText }) {
    if (!env.AI) throw new Error('The AI binding is missing. Check the "ai" section of wrangler.jsonc.');
    const params = workersParams(m, messages, { stream, maxTokens });
    const inputChars = JSON.stringify(messages).length;
    if (stream) {
      const s = await env.AI.run(m, params);
      const { text, usage } = await readStream(s, onText);
      await recordNeurons(neuronsFor(m, usage, { input: inputChars, output: text.length }));
      return text;
    }
    const result = await env.AI.run(m, params);
    const text = textFromResult(result);
    await recordNeurons(neuronsFor(m, result?.usage, { input: inputChars, output: text.length }));
    return text;
  }

  // Busy (3040)? Try the fallback model once, but never after text has already streamed.
  async function runWithFallback(messages, opts) {
    let streamed = false;
    const onText = opts.onText ? (t) => ((streamed = true), opts.onText(t)) : undefined;
    try {
      return await runWorkers(model, messages, { ...opts, onText });
    } catch (err) {
      const busy = /\b3040\b|capacity temporarily exceeded/i.test(String(err?.message || ''));
      if (!busy || streamed || model === FALLBACK_WORKERS_MODEL || env.AI_MODEL) throw err;
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

    // Returns { raw, reset, risk } like the Node server.
    async reply(state, onDelta) {
      const pending = await store.unansweredUserMessages();
      const risk = pending.some((m) => looksLikeCrisis(m.text));
      if (provider === 'mock') {
        const raw = mockReplyText({
          lastUserText: pending.map((m) => m.text).join(' '),
          hasFiles: pending.some((m) => m.attachments?.length),
          tone: state.settings.tone,
        });
        await streamMock(raw, onDelta);
        return { raw, risk };
      }
      const turns = await history(state);
      if (turns.at(-1)?.role !== 'user') throw new Error('There is nothing new to reply to.');
      if (risk) appendUserNote(turns, CRISIS_NOTE);

      if (provider === 'anthropic') {
        const stream = claudeClient().beta.messages.stream(claudeParams(state, turns, { effort: env.CHAT_EFFORT || 'medium' }));
        stream.on('text', (t) => onDelta(t));
        const final = await stream.finalMessage();
        if (final.stop_reason === 'refusal') return { raw: REFUSAL_REPLY, reset: true, risk };
        return { raw: claudeText(final) || EMPTY_REPLY, risk };
      }

      const text = await runWithFallback(toChatMessages(systemText(state), turns), { stream: true, maxTokens: 700, onText: onDelta });
      return { raw: text.trim() || EMPTY_REPLY, risk };
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
          const final = await claudeClient().beta.messages.stream(claudeParams(state, turns, { effort: 'low', maxTokens: 16000 })).finalMessage();
          return final.stop_reason === 'refusal' ? null : claudeText(final) || null;
        }
        return (await runWithFallback(toChatMessages(systemText(state), turns), { stream: false, maxTokens: 300 })).trim() || null;
      } catch (err) {
        if (isQuotaError(err)) return SIMPLE_CHECKINS[Math.floor(Math.random() * SIMPLE_CHECKINS.length)];
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
            .beta.messages.stream(claudeParams(state, [{ role: 'user', content: prompt }], { effort: 'low', maxTokens: 16000, system: MEMORY_INSTRUCTIONS }))
            .finalMessage();
          if (final.stop_reason === 'refusal') return;
          notes = claudeText(final);
        } else {
          notes = (
            await runWithFallback(
              [
                { role: 'system', content: MEMORY_INSTRUCTIONS },
                { role: 'user', content: prompt },
              ],
              { stream: false, maxTokens: 600 },
            )
          ).trim();
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

