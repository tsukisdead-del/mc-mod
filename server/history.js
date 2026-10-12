// Turns stored messages into model-ready conversation turns. Pure functions with no Node APIs, so the
// Node server and the Cloudflare Worker build exactly the same conversation for the model.
import { formatStamp } from './time.js';
import { plainText } from '../public/js/reply-format.js';

// How many of the latest messages still carry their photos/documents in full.
export const RECENT_FILE_MESSAGES = 8;
// Notes ("memory") are refreshed after this many new messages.
export const MEMORY_EVERY = 12;
// Once the verbatim history passes WINDOW_MAX messages, older ones are dropped down to WINDOW_KEEP
// (they live on in the memory notes). Jumping in chunks keeps the prompt cache warm.
export const WINDOW_MAX = 80;
export const WINDOW_KEEP = 40;

/**
 * Builds alternating user/assistant turns from stored messages (oldest first).
 * Each turn is { role, content: parts[] } where a part is { type: 'text', text } or
 * { type: 'files', ids } (attachments still to be loaded by the caller, provider-specific).
 * Deterministic for the same input, so prompt caching keeps hitting.
 */
export function buildTurns(messages, { timezone, filePlaceholder, recentFiles = RECENT_FILE_MESSAGES }) {
  const firstWithFullFiles = messages.length - recentFiles;
  const out = [];
  const push = (role, parts) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...parts);
    else out.push({ role, content: [...parts] });
  };

  messages.forEach((m, i) => {
    if (m.role === 'user') {
      const parts = [];
      if (m.attachments?.length) {
        if (i >= firstWithFullFiles) parts.push({ type: 'files', ids: m.attachments });
        else {
          const note = filePlaceholder(m.attachments);
          if (note) parts.push({ type: 'text', text: note });
        }
      }
      const body = m.text?.trim() || (m.attachments?.length ? '(sent without a message)' : '…');
      parts.push({ type: 'text', text: `[${formatStamp(m.createdAt, timezone)}] ${body}` });
      push('user', parts);
    } else {
      if (m.kind === 'checkin') {
        push('user', [{ type: 'text', text: `[App note: ${formatStamp(m.createdAt, timezone)}. No new message from them; you texted first to check in.]` }]);
      }
      push('assistant', [{ type: 'text', text: m.text }]);
    }
  });
  if (out[0]?.role === 'assistant') out.unshift({ role: 'user', content: [{ type: 'text', text: '[App note: start of the conversation.]' }] });
  return out;
}

// Replace each { type: 'files' } part with whatever `load(ids)` returns (an array of parts).
export async function resolveFiles(turns, load) {
  for (const turn of turns) {
    const parts = [];
    for (const p of turn.content) {
      if (p.type === 'files') parts.push(...(await load(p.ids)));
      else parts.push(p);
    }
    turn.content = parts;
  }
  return turns;
}

// Adds an app instruction as the final user turn (used for check-ins, where they haven't said anything new).
export function appendUserNote(turns, text) {
  const note = { type: 'text', text };
  if (turns.at(-1)?.role === 'user') turns.at(-1).content.push(note);
  else turns.push({ role: 'user', content: [note] });
  return turns;
}

// Plain-text transcript for the memory-notes prompt.
export function transcript(messages, { timezone, therapistName, filePlaceholder }) {
  return messages
    .map((m) => {
      const who = m.role === 'user' ? 'Them' : `You (${therapistName})`;
      const files = m.role === 'user' ? filePlaceholder(m.attachments) : '';
      const body = m.role === 'user' ? m.text : plainText(m.text);
      return `[${formatStamp(m.createdAt, timezone)}] ${who}: ${[files, body].filter(Boolean).join(' ')}`;
    })
    .join('\n');
}

// After the notes cover everything up to `coveredUntil`, where should the verbatim history start?
// Never drops a message the notes don't cover yet.
export function nextHistoryStart(messages, historyStart, coveredUntil, { max = WINDOW_MAX, keep = WINDOW_KEEP } = {}) {
  const inWindow = messages.filter((m) => m.createdAt >= historyStart);
  if (inWindow.length <= max) return historyStart;
  const candidate = inWindow[inWindow.length - keep].createdAt;
  const firstUncovered = messages.find((m) => m.createdAt > coveredUntil)?.createdAt ?? Infinity;
  return Math.min(candidate, firstUncovered);
}
