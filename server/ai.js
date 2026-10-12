import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { state, save } from './store.js';
import { PERSONA, settingsBlock, checkinInstruction, MEMORY_INSTRUCTIONS } from './prompts.js';
import { attachmentBlocks, attachmentPlaceholder } from './attachments.js';
import { buildTurns, resolveFiles, appendUserNote, transcript, nextHistoryStart, MEMORY_EVERY } from './history.js';
import { looksLikeCrisis, CRISIS_NOTE } from './safety.js';
import { mockReplyText, mockCheckinText, mockMemoryText, streamMock } from './mock.js';

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

// Stored messages -> Messages API turns. Deterministic, so the prompt cache keeps hitting.
async function buildHistory() {
  const turns = buildTurns(
    state.messages.filter((m) => m.createdAt >= state.historyStart),
    { timezone: state.settings.timezone, filePlaceholder: attachmentPlaceholder },
  );
  return resolveFiles(turns, attachmentBlocks);
}

// ---------- Chat replies ----------

// Their messages since your last reply.
function unansweredUserMessages() {
  const out = [];
  for (let i = state.messages.length - 1; i >= 0 && state.messages[i].role === 'user'; i--) out.unshift(state.messages[i]);
  return out;
}

// Returns { raw, reset, risk }: raw reply text, whether streamed text should be discarded,
// and whether the keyword backstop saw crisis language.
export async function generateReply({ onDelta }) {
  const pending = unansweredUserMessages();
  const risk = pending.some((m) => looksLikeCrisis(m.text));
  if (config.mockAI) {
    const raw = mockReplyText({
      lastUserText: pending.map((m) => m.text).join(' '),
      hasFiles: pending.some((m) => m.attachments?.length),
      tone: state.settings.tone,
    });
    await streamMock(raw, onDelta);
    return { raw, risk };
  }
  const messages = await buildHistory();
  if (messages.at(-1)?.role !== 'user') throw new FriendlyError('There is nothing new to reply to.');
  if (risk) appendUserNote(messages, CRISIS_NOTE);

  const stream = getClient().beta.messages.stream(requestParams({ messages, effort: config.chatEffort }));
  stream.on('text', (delta) => onDelta(delta));
  const final = await stream.finalMessage();

  // The whole fallback chain declined: discard any partial text.
  if (final.stop_reason === 'refusal') return { raw: REFUSAL_REPLY, reset: true, risk };
  return { raw: textOf(final) || EMPTY_REPLY, risk };
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
  if (config.mockAI) return mockCheckinText();

  const messages = appendUserNote(await buildHistory(), instruction);

  const stream = getClient().beta.messages.stream(requestParams({ messages, effort: 'low', maxTokens: 16000 }));
  const final = await stream.finalMessage();
  if (final.stop_reason === 'refusal') return null;
  return textOf(final) || null;
}

// ---------- Long-term memory ----------

let memoryBusy = false;

export async function maybeUpdateMemory({ force = false } = {}) {
  if (memoryBusy) return;
  const pending = state.messages.filter((m) => m.createdAt > state.memory.coveredUntil);
  if (!pending.length || (!force && pending.length < MEMORY_EVERY)) return;
  memoryBusy = true;
  try {
    let notes;
    if (config.mockAI) {
      notes = mockMemoryText(state.memory.text, pending);
    } else {
      const convo = transcript(pending, {
        timezone: state.settings.timezone,
        therapistName: state.settings.therapistName,
        filePlaceholder: attachmentPlaceholder,
      });
      const prompt = `Current notes:\n${state.memory.text || '(none yet)'}\n\nNewest conversation:\n${convo}`;
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
    state.historyStart = nextHistoryStart(state.messages, state.historyStart, state.memory.coveredUntil);
    save();
  } catch (err) {
    console.error('Memory update failed:', err.message);
  } finally {
    memoryBusy = false;
  }
}
