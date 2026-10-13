import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { state, save } from './store.js';
import { PERSONA, settingsBlock, checkinInstruction, MEMORY_INSTRUCTIONS } from './prompts.js';
import { attachmentPlaceholder, prepareFiles, claudeParts, localParts, excerptBlocks } from './attachments.js';
import { buildTurns, resolveFiles, appendUserNote, transcript, nextHistoryStart, MEMORY_EVERY, RECENT_FILE_MESSAGES } from './history.js';
import { DOC_BUDGETS, scaleBudget, searchTextFor } from './doc-search.js';
import { looksLikeCrisis, CRISIS_NOTE } from './safety.js';
import { mockReplyText, mockCheckinText, mockMemoryText, streamMock } from './mock.js';
import { FORMAT_REMINDER, simpleCheckin, toOllamaMessages, readNdjson } from './open-models.js';

// The local model (Ollama) gets a shorter verbatim history (the memory notes carry the rest), photos only on
// the turn they're sent, and a smaller document budget (doc-search.js), so everything fits its context window.
const LOCAL_WINDOW = { max: 40, keep: 20 };
const LOCAL_DOC_TURNS = 6;
const OLLAMA_DOWN =
  "I can't reach Ollama, the free AI that runs on this computer. Open the Ollama app (or run `ollama serve`) and try again. (Or add an ANTHROPIC_API_KEY to use Claude instead.)";

const REFUSAL_REPLY =
  "[[mood:concerned]] I'm not able to respond to that one, sorry.\n|||\nI'm still here though. Want to tell me what's going on in a different way?";
const EMPTY_REPLY = '[[mood:thinking]] Sorry, my brain glitched for a second. Can you say that again?';

let client = null;
function getClient() {
  if (!client) {
    if (!config.hasApiKey)
      throw new FriendlyError("The server has no ANTHROPIC_API_KEY set yet, so I can't think. Add it in your hosting settings and restart.");
    client = new Anthropic();
  }
  return client;
}

export class FriendlyError extends Error {}

export function friendlyMessage(err) {
  if (err instanceof FriendlyError) return err.message;
  if (err instanceof Anthropic.AuthenticationError)
    return "The server's Claude API key isn't working. Double-check ANTHROPIC_API_KEY in your hosting settings.";
  if (err instanceof Anthropic.PermissionDeniedError)
    return "The Claude API key doesn't have access to this model. Check your Anthropic account or set CLAUDE_MODEL.";
  if (err instanceof Anthropic.RateLimitError) return "I'm getting a lot of messages at once. Give it a minute and try again.";
  if (err instanceof Anthropic.BadRequestError)
    return "Something about that message didn't work (a file might be too big or unreadable). Try again without it?";
  if (err instanceof Anthropic.InternalServerError) return 'My brain is having a moment on the server side. Try again in a bit.';
  if (err instanceof Anthropic.APIConnectionError) return "I can't reach my brain right now (network issue). Try again in a moment.";
  return 'Something went wrong on my end. Try again?';
}

export function providerInfo() {
  if (config.aiProvider === 'ollama') {
    return {
      provider: 'ollama',
      model: config.ollamaModel,
      modelLabel: `${config.ollamaModel} (Ollama, on this computer)`,
    };
  }
  if (config.aiProvider === 'mock') return { provider: 'mock', model: 'demo', modelLabel: 'Demo replies' };
  return {
    provider: 'anthropic',
    model: config.model,
    modelLabel: config.model,
  };
}

// ---------- Ollama (free, runs on this computer) ----------

let ollamaThinkParam = true;

// Connection problems mean Ollama isn't running; anything else is a real error from Ollama.
const NOT_RUNNING = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ECONNRESET']);

function ollamaProblem(status, detail) {
  let message = detail;
  try {
    message = JSON.parse(detail).error || detail;
  } catch {
    // plain text
  }
  if (/memory/i.test(message)) {
    return new FriendlyError(
      `The ${config.ollamaModel} model needs more memory than this computer has free. Close some apps, or use a smaller model: ollama pull gemma4:e2b, then set OLLAMA_MODEL=gemma4:e2b.`,
    );
  }
  return new FriendlyError(`Ollama had a problem (${status}): ${String(message).slice(0, 200)}`);
}

// One chat call to Ollama's native API (it lets us size the context window and turn hidden thinking off).
// Always streamed, so a slow computer never hits a timeout waiting for the whole reply. Returns { text, finish }.
async function ollamaChat(messages, { onText, maxTokens = 700 } = {}) {
  const body = {
    model: config.ollamaModel,
    messages,
    stream: true,
    keep_alive: '30m',
    options: {
      num_ctx: config.ollamaNumCtx,
      temperature: 0.7,
      num_predict: maxTokens,
    },
  };
  if (ollamaThinkParam) body.think = false;
  let res;
  try {
    res = await fetch(`${config.ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (NOT_RUNNING.has(err?.cause?.code)) throw new FriendlyError(OLLAMA_DOWN);
    throw err;
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    // Some models reject the "think" switch; drop it and try again.
    if (res.status === 400 && ollamaThinkParam && /think/i.test(detail)) {
      ollamaThinkParam = false;
      return ollamaChat(messages, { onText, maxTokens });
    }
    if (res.status === 404) {
      throw new FriendlyError(`The ${config.ollamaModel} model isn't on this computer yet. In a terminal, run: ollama pull ${config.ollamaModel}`);
    }
    throw ollamaProblem(res.status, detail);
  }
  const { text, finish } = await readNdjson(res.body, onText);
  return { text: text.trim(), finish };
}

function localSystem() {
  return `${PERSONA}\n\n${settingsBlock(state.settings, state.memory.text)}\n\n${FORMAT_REMINDER}`;
}

// The conversation for the model, with files: photos, documents whole when short, and for long documents
// their opening plus the parts that match what they just said (search: replies do, check-ins don't).
async function conversation({ claude, search }) {
  const messages = state.messages.filter((m) => m.createdAt >= state.historyStart);
  const fresh = new Set(unansweredUserMessages().flatMap((m) => m.attachments || []));
  const turns = buildTurns(messages, {
    timezone: state.settings.timezone,
    filePlaceholder: attachmentPlaceholder,
    recentFiles: claude ? RECENT_FILE_MESSAGES : LOCAL_DOC_TURNS,
  });
  const budget = claude ? DOC_BUDGETS.claude : scaleBudget(DOC_BUDGETS.local, config.ollamaNumCtx / 16384);
  const files = await prepareFiles({ turns, messages, fresh, query: search ? searchTextFor(messages) : '', budget, claude });
  await resolveFiles(turns, (ids) => (claude ? claudeParts(ids, files) : localParts(ids, files, { vision: config.ollamaVision })));
  const last = turns.at(-1);
  if (last?.role !== 'user') return turns;
  // Claude: cache everything up to here, so the notes added after it (which change every turn) don't stop the
  // next reply from reusing it.
  if (claude && last.content.length) last.content.at(-1).cache_control = { type: 'ephemeral' };
  // Matching parts go with their newest message, so earlier turns stay the same.
  last.content.push(...excerptBlocks(files, claude));
  return turns;
}

// ---------- Claude ----------

function systemBlocks() {
  return [
    { type: 'text', text: PERSONA },
    // Breakpoint here: persona + settings + memory stay cached until settings or memory change.
    {
      type: 'text',
      text: settingsBlock(state.settings, state.memory.text),
      cache_control: { type: 'ephemeral' },
    },
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
  if (config.aiProvider === 'ollama') {
    const turns = await conversation({ claude: false, search: true });
    if (turns.at(-1)?.role !== 'user') throw new FriendlyError('There is nothing new to reply to.');
    if (risk) appendUserNote(turns, CRISIS_NOTE);
    const { text } = await ollamaChat(toOllamaMessages(localSystem(), turns), { onText: onDelta, maxTokens: 700 });
    return { raw: text || EMPTY_REPLY, risk };
  }
  const messages = await conversation({ claude: true, search: true });
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
  if (config.aiProvider === 'ollama') {
    try {
      const turns = appendUserNote(await conversation({ claude: false, search: false }), instruction);
      return (await ollamaChat(toOllamaMessages(localSystem(), turns), { maxTokens: 300 })).text || null;
    } catch (err) {
      // Ollama is closed or busy: still check in, with a simple message.
      if (err instanceof FriendlyError) return simpleCheckin();
      throw err;
    }
  }

  const messages = appendUserNote(await conversation({ claude: true, search: false }), instruction);

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
      if (config.aiProvider === 'ollama') {
        const { text, finish } = await ollamaChat(
          [
            { role: 'system', content: MEMORY_INSTRUCTIONS },
            { role: 'user', content: prompt },
          ],
          { maxTokens: 600 },
        );
        // Cut off mid-note: keep the old notes rather than lose their tail; it tries again later.
        if (finish === 'length') {
          console.error('Memory notes came back cut off; keeping the old ones.');
          return;
        }
        notes = text;
      } else {
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
    }
    if (!notes) return;
    state.memory = {
      text: notes,
      updatedAt: Date.now(),
      coveredUntil: pending[pending.length - 1].createdAt,
    };
    const window = config.aiProvider === 'ollama' ? LOCAL_WINDOW : undefined;
    state.historyStart = nextHistoryStart(state.messages, state.historyStart, state.memory.coveredUntil, window);
    save();
  } catch (err) {
    console.error('Memory update failed:', err.message);
  } finally {
    memoryBusy = false;
  }
}
