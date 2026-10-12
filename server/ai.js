import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { state, save } from './store.js';
import { PERSONA, settingsBlock, checkinInstruction, MEMORY_INSTRUCTIONS, toneBand } from './prompts.js';
import { attachmentBlocks, attachmentPlaceholder } from './attachments.js';
import { formatStamp } from './time.js';
import { plainText } from '../public/js/reply-format.js';

// How many of the latest messages still carry their photos/documents in full.
const RECENT_FILE_MESSAGES = 8;
// Notes ("memory") are refreshed after this many new messages.
const MEMORY_EVERY = 12;
// Once the verbatim history passes WINDOW_MAX messages, older ones are dropped down to
// WINDOW_KEEP (they live on in the memory notes). Jumping in chunks keeps the prompt cache warm.
const WINDOW_MAX = 80;
const WINDOW_KEEP = 40;

const REFUSAL_REPLY =
  "[[mood:concerned]] I'm not able to respond to that one, sorry.\n|||\nI'm still here though. Want to tell me what's going on in a different way?";
const EMPTY_REPLY = "[[mood:thinking]] Sorry, my brain glitched for a second. Can you say that again?";

let client = null;
function getClient() {
  if (!client) {
    if (!config.hasApiKey) throw new FriendlyError('The server has no ANTHROPIC_API_KEY set yet, so I can\'t think. Add it in your hosting settings and restart.');
    client = new Anthropic();
  }
  return client;
}

export class FriendlyError extends Error {}

export function friendlyMessage(err) {
  if (err instanceof FriendlyError) return err.message;
  if (err instanceof Anthropic.AuthenticationError) return "The server's Claude API key isn't working. Double-check ANTHROPIC_API_KEY in your hosting settings.";
  if (err instanceof Anthropic.PermissionDeniedError) return "The Claude API key doesn't have access to this model. Check your Anthropic account or set CLAUDE_MODEL.";
  if (err instanceof Anthropic.RateLimitError) return "I'm getting a lot of messages at once. Give it a minute and try again.";
  if (err instanceof Anthropic.BadRequestError) return "Something about that message didn't work (a file might be too big or unreadable). Try again without it?";
  if (err instanceof Anthropic.InternalServerError) return 'My brain is having a moment on the server side. Try again in a bit.';
  if (err instanceof Anthropic.APIConnectionError) return "I can't reach my brain right now (network issue). Try again in a moment.";
  return 'Something went wrong on my end. Try again?';
}

function systemBlocks() {
  return [
    { type: 'text', text: PERSONA },
    // Breakpoint here: persona + settings + memory stay cached until settings or memory change.
    { type: 'text', text: settingsBlock(state.settings, state.memory.text), cache_control: { type: 'ephemeral' } },
  ];
}

function supportsServerFallbacks() {
  return process.env.CLAUDE_FALLBACKS !== 'off' && /^claude-(opus-5|sonnet-5-5|fable-5)/.test(config.model);
}

function requestParams({ messages, effort, system = systemBlocks(), maxTokens = 64000 }) {
  const params = {
    model: config.model,
    max_tokens: maxTokens,
    system,
    messages,
    cache_control: { type: 'ephemeral' }, // automatic caching of the growing conversation
  };
  if (effort && effort !== 'none') params.output_config = { effort };
  if (supportsServerFallbacks()) {
    // If a safety classifier declines, the API retries on Anthropic's recommended fallback model.
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }
  return params;
}

function textOf(message) {
  return message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

// Turn stored messages into Messages API turns. Deterministic, so the prompt cache keeps hitting.
async function buildHistory() {
  const tz = state.settings.timezone;
  const msgs = state.messages.filter((m) => m.createdAt >= state.historyStart);
  const firstWithFullFiles = msgs.length - RECENT_FILE_MESSAGES;
  const out = [];
  const push = (role, blocks) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: [...blocks] });
  };

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === 'user') {
      const blocks = [];
      if (m.attachments?.length) {
        if (i >= firstWithFullFiles) blocks.push(...(await attachmentBlocks(m.attachments)));
        else {
          const note = attachmentPlaceholder(m.attachments);
          if (note) blocks.push({ type: 'text', text: note });
        }
      }
      const body = m.text?.trim() || (m.attachments?.length ? '(sent without a message)' : '…');
      blocks.push({ type: 'text', text: `[${formatStamp(m.createdAt, tz)}] ${body}` });
      push('user', blocks);
    } else {
      if (m.kind === 'checkin') {
        push('user', [{ type: 'text', text: `[App note: ${formatStamp(m.createdAt, tz)}. No new message from them; you texted first to check in.]` }]);
      }
      push('assistant', [{ type: 'text', text: m.text }]);
    }
  }
  if (out[0]?.role === 'assistant') out.unshift({ role: 'user', content: [{ type: 'text', text: '[App note: start of the conversation.]' }] });
  return out;
}

// ---------- Chat replies ----------

export async function generateReply({ onDelta }) {
  if (config.mockAI) return mockReply(onDelta);
  const messages = await buildHistory();
  if (messages.at(-1)?.role !== 'user') throw new FriendlyError('There is nothing new to reply to.');

  const stream = getClient().beta.messages.stream(requestParams({ messages, effort: config.chatEffort }));
  stream.on('text', (delta) => onDelta(delta));
  const final = await stream.finalMessage();

  // The whole fallback chain declined: discard any partial text.
  if (final.stop_reason === 'refusal') return { raw: REFUSAL_REPLY, reset: true };
  return { raw: textOf(final) || EMPTY_REPLY };
}

// ---------- Check-ins (the therapist texts first) ----------

export async function generateCheckin() {
  const now = Date.now();
  const lastUser = state.lastUserMessageAt;
  const instruction = checkinInstruction(state.settings, {
    now,
    lastUserAt: lastUser,
    hasHistory: state.messages.length > 0 || Boolean(state.memory.text),
    unanswered: state.checkin.unanswered,
  });
  if (config.mockAI) return mockCheckin();

  const messages = await buildHistory();
  const note = { type: 'text', text: instruction };
  if (messages.at(-1)?.role === 'user') messages.at(-1).content.push(note);
  else messages.push({ role: 'user', content: [note] });

  const stream = getClient().beta.messages.stream(requestParams({ messages, effort: 'low', maxTokens: 16000 }));
  const final = await stream.finalMessage();
  if (final.stop_reason === 'refusal') return null;
  return textOf(final) || null;
}

// ---------- Long-term memory ----------

let memoryBusy = false;

function transcript(msgs) {
  const tz = state.settings.timezone;
  return msgs
    .map((m) => {
      const who = m.role === 'user' ? 'Them' : `You (${state.settings.therapistName})`;
      const files = m.role === 'user' ? attachmentPlaceholder(m.attachments) : '';
      const body = m.role === 'user' ? m.text : plainText(m.text);
      return `[${formatStamp(m.createdAt, tz)}] ${who}: ${[files, body].filter(Boolean).join(' ')}`;
    })
    .join('\n');
}

export async function maybeUpdateMemory({ force = false } = {}) {
  if (memoryBusy) return;
  const pending = state.messages.filter((m) => m.createdAt > state.memory.coveredUntil);
  if (!pending.length || (!force && pending.length < MEMORY_EVERY)) return;
  memoryBusy = true;
  try {
    let notes;
    if (config.mockAI) {
      notes = mockMemory(pending);
    } else {
      const prompt = `Current notes:\n${state.memory.text || '(none yet)'}\n\nNewest conversation:\n${transcript(pending)}`;
      const final = await getClient()
        .beta.messages.stream(
          requestParams({
            system: MEMORY_INSTRUCTIONS,
            messages: [{ role: 'user', content: prompt }],
            effort: 'low',
            maxTokens: 16000,
          }),
        )
        .finalMessage();
      if (final.stop_reason === 'refusal') return;
      notes = textOf(final);
    }
    if (!notes) return;
    state.memory = { text: notes, updatedAt: Date.now(), coveredUntil: pending[pending.length - 1].createdAt };
    advanceHistoryWindow();
    save();
  } catch (err) {
    console.error('Memory update failed:', err.message);
  } finally {
    memoryBusy = false;
  }
}

function advanceHistoryWindow() {
  const inWindow = state.messages.filter((m) => m.createdAt >= state.historyStart);
  if (inWindow.length <= WINDOW_MAX) return;
  const candidate = inWindow[inWindow.length - WINDOW_KEEP].createdAt;
  // Never drop a message the notes don't cover yet.
  const firstUncovered = state.messages.find((m) => m.createdAt > state.memory.coveredUntil)?.createdAt ?? Infinity;
  state.historyStart = Math.min(candidate, firstUncovered);
}

// ---------- Demo mode (MOCK_AI=1): no API key needed ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mockReply(onDelta) {
  const last = [...state.messages].reverse().find((m) => m.role === 'user');
  const text = (last?.text || '').toLowerCase();
  const tone = state.settings.tone;
  const band = toneBand(tone).label;
  let raw;
  if (/\b(kill myself|suicid|end it all|want to die|hurt myself)\b/.test(text)) {
    raw = "[[mood:concerned]] I'm really glad you told me. Are you safe right now?\n|||\nYou don't have to carry this alone. You can call or text **988** any time, or text HOME to 741741. If you're in danger right now, call 911. [[crisis]]\n|||\nI'm staying right here with you. What's happening tonight?";
  } else if (last?.attachments?.length) {
    raw = `[[mood:curious]] (Demo mode) I got your ${last.attachments.length > 1 ? 'files' : 'file'}! With a real API key I'd look at it closely and tell you what I notice.\n|||\nWhat made you want to share it with me?`;
  } else if (tone > 64) {
    raw = `[[mood:laughing]] okay okay I hear you 😂 (demo mode, tone ${tone}: ${band})\n|||\nreal talk though, what's actually going on?`;
  } else if (tone < 36) {
    raw = `[[mood:warm]] Thank you for sharing that with me. It sounds like there's a lot on your mind. (Demo mode, tone ${tone}: ${band})\n|||\nTake your time. What feels heaviest right now?`;
  } else {
    raw = `[[mood:thinking]] Hmm, I hear you. (Demo mode, tone ${tone}: ${band})\n|||\nWhat do you think is underneath that feeling?`;
  }
  await sleep(500);
  for (let i = 0; i < raw.length; i += 3) {
    onDelta(raw.slice(i, i + 3));
    await sleep(18);
  }
  return { raw };
}

function mockCheckin() {
  const options = [
    "[[mood:warm]] hey, just thinking about you. how's your day going?",
    '[[mood:happy]] checking in! did you drink some water today? 💧',
    "[[mood:proud]] random reminder that you're doing better than you think.\n|||\nhow are you feeling right now?",
  ];
  return options[Math.floor(Math.random() * options.length)];
}

function mockMemory(pending) {
  const said = pending.filter((m) => m.role === 'user' && m.text).map((m) => `- They said: "${m.text.slice(0, 80)}"`);
  return [state.memory.text, ...said.slice(-5)].filter(Boolean).join('\n').slice(-1500);
}
