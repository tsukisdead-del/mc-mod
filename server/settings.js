import { isValidTimeZone } from './time.js';

// Either a fixed gap in hours, or a number of check-ins spread across the active hours each day.
export const FREQUENCIES = {
  rarely: { label: 'Every few days', hours: 72 },
  few_week: { label: 'A few times a week', hours: 40 },
  daily: { label: 'About once a day', perDay: 1 },
  twice_daily: { label: 'Twice a day', perDay: 2 },
  often: { label: 'Every few hours', perDay: 4 },
};

export const CHECKIN_STYLES = ['mood', 'followups', 'encouragement', 'selfcare'];

export function defaultSettings() {
  return {
    therapistName: 'Dr. Mochi',
    userName: '',
    tone: 50, // 0 = gentle & therapeutic … 100 = keep it real
    allowCursing: false,
    emojis: true,
    timezone: 'America/New_York',
    checkins: {
      enabled: true,
      frequency: 'daily',
      startHour: 10,
      endHour: 21,
      styles: { mood: true, followups: true, encouragement: true, selfcare: false },
      replyNotifications: true, // push a notification when a reply finishes while the app is closed
    },
  };
}

const clampInt = (v, min, max, fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

const cleanText = (v, max) =>
  typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : undefined;

// Merge an untrusted patch from the client into the current settings.
export function applySettingsPatch(current, patch) {
  const next = structuredClone(current);
  if (!patch || typeof patch !== 'object') return next;

  const name = cleanText(patch.therapistName, 40);
  if (name !== undefined) next.therapistName = name || 'Dr. Mochi';
  const userName = cleanText(patch.userName, 40);
  if (userName !== undefined) next.userName = userName;
  if (patch.tone !== undefined) next.tone = clampInt(patch.tone, 0, 100, next.tone);
  if (typeof patch.allowCursing === 'boolean') next.allowCursing = patch.allowCursing;
  if (typeof patch.emojis === 'boolean') next.emojis = patch.emojis;
  if (isValidTimeZone(patch.timezone)) next.timezone = patch.timezone;

  const c = patch.checkins;
  if (c && typeof c === 'object') {
    if (typeof c.enabled === 'boolean') next.checkins.enabled = c.enabled;
    if (typeof c.frequency === 'string' && FREQUENCIES[c.frequency]) next.checkins.frequency = c.frequency;
    if (c.startHour !== undefined) next.checkins.startHour = clampInt(c.startHour, 0, 23, next.checkins.startHour);
    if (c.endHour !== undefined) next.checkins.endHour = clampInt(c.endHour, 0, 23, next.checkins.endHour);
    if (typeof c.replyNotifications === 'boolean') next.checkins.replyNotifications = c.replyNotifications;
    if (c.styles && typeof c.styles === 'object') {
      for (const key of CHECKIN_STYLES) {
        if (typeof c.styles[key] === 'boolean') next.checkins.styles[key] = c.styles[key];
      }
    }
  }
  return next;
}

// Fill in any keys missing from settings saved by an older version.
export function withDefaults(saved) {
  const d = defaultSettings();
  if (!saved || typeof saved !== 'object') return d;
  return {
    ...d,
    ...saved,
    checkins: {
      ...d.checkins,
      ...(saved.checkins || {}),
      styles: { ...d.checkins.styles, ...(saved.checkins?.styles || {}) },
    },
  };
}
