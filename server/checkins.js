// When to check in. Pure functions shared by the Node server and the Cloudflare Worker.
import { FREQUENCIES } from './settings.js';
import { inWindow, nextWindowStart, windowLengthHours } from './time.js';

export const HOUR = 60 * 60 * 1000;
// Don't check in if they talked to you very recently.
export const QUIET_AFTER_CHAT = 2 * HOUR;
// After this many ignored check-ins, stop until they write back.
export const MAX_UNANSWERED = 3;

function pickNextTime(settings, unanswered, from, random) {
  const c = settings.checkins;
  const f = FREQUENCIES[c.frequency] || FREQUENCIES.daily;
  const windowHours = windowLengthHours(c.startHour, c.endHour);
  const base = (f.hours ?? (f.perDay === 1 ? 24 : Math.max(1.5, windowHours / f.perDay))) * HOUR;
  // Back off a little for each check-in they haven't answered.
  const interval = base * (1 + 0.5 * unanswered);
  let next = from + interval * (0.8 + random() * 0.4);
  if (!inWindow(next, settings.timezone, c.startHour, c.endHour)) {
    const start = nextWindowStart(next, settings.timezone, c.startHour, c.endHour);
    next = start + random() * Math.min(2, windowHours / 2) * HOUR;
  }
  return Math.round(next);
}

// The next check-in time, or null when check-ins are off or paused.
export function scheduleNext(settings, checkin, from, random = Math.random) {
  if (!settings.checkins.enabled || checkin.unanswered >= MAX_UNANSWERED) return null;
  return pickNextTime(settings, checkin.unanswered, from, random);
}

// They sent a message: reset the ignored count; returns true when the schedule should be recomputed.
export function noteActivity(checkin, now) {
  const wasPaused = checkin.unanswered >= MAX_UNANSWERED;
  checkin.unanswered = 0;
  return wasPaused || !checkin.nextAt || checkin.nextAt - now < QUIET_AFTER_CHAT;
}

// What the periodic tick should do: 'wait', 'send', or { reschedule: fromTime }.
export function tickAction({ settings, checkin, lastUserMessageAt, now }) {
  const c = settings.checkins;
  if (!c.enabled) return 'wait';
  if (!checkin.nextAt) return checkin.unanswered < MAX_UNANSWERED ? { reschedule: now } : 'wait';
  if (now < checkin.nextAt) return 'wait';
  const talkedRecently = lastUserMessageAt && now - lastUserMessageAt < QUIET_AFTER_CHAT;
  // Server slept through the slot, it's outside their hours, or they're mid-conversation: pick a new time.
  if (now - checkin.nextAt > 3 * HOUR || talkedRecently || !inWindow(now, settings.timezone, c.startHour, c.endHour)) {
    return { reschedule: talkedRecently ? lastUserMessageAt : now };
  }
  return 'send';
}
