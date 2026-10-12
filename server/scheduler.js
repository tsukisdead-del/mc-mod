import { state, save, addMessage } from './store.js';
import { scheduleNext, noteActivity, tickAction, HOUR } from './checkins.js';
import { generateCheckin } from './ai.js';
import { notifyMessage } from './push.js';
import { parseReply } from '../public/js/reply-format.js';
import { withLock } from './lock.js';

const listeners = new Set();
export function onCheckin(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function reschedule(from = Date.now()) {
  state.checkin.nextAt = scheduleNext(state.settings, state.checkin, from);
  save();
}

// Called whenever they send a message.
export function noteUserActivity() {
  const now = Date.now();
  state.lastUserMessageAt = now;
  if (noteActivity(state.checkin, now)) reschedule(now);
  save();
}

export async function sendCheckinNow({ manual = false } = {}) {
  return withLock(async () => {
    const raw = await generateCheckin();
    if (!raw) throw new Error('No check-in text was generated');
    const parsed = parseReply(raw);
    const msg = addMessage({ role: 'assistant', kind: 'checkin', text: raw, mood: parsed.mood, crisis: parsed.crisis });
    state.checkin.lastSentAt = msg.createdAt;
    if (!manual) state.checkin.unanswered++;
    reschedule();
    await notifyMessage(raw, 'checkin');
    for (const fn of listeners) fn(msg);
    return msg;
  });
}

async function tick() {
  const now = Date.now();
  const action = tickAction({
    settings: state.settings,
    checkin: state.checkin,
    lastUserMessageAt: state.lastUserMessageAt,
    now,
  });
  if (action === 'wait') return;
  if (action !== 'send') {
    reschedule(action.reschedule);
    return;
  }
  try {
    await sendCheckinNow();
  } catch (err) {
    console.error('Check-in failed:', err.message);
    state.checkin.nextAt = now + HOUR; // try again later
    save();
  }
}

let timer = null;
export function startScheduler() {
  if (timer) return;
  timer = setInterval(() => tick().catch((e) => console.error(e)), 60 * 1000);
  setTimeout(() => tick().catch((e) => console.error(e)), 5000);
}
