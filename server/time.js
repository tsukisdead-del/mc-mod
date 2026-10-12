// Timezone helpers built on Intl, so check-ins land at the right local time (DST included).

const partsCache = new Map();

function formatter(timeZone) {
  let f = partsCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    partsCache.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function localParts(ts, timeZone) {
  const out = {};
  for (const p of formatter(timeZone).formatToParts(new Date(ts))) out[p.type] = p.value;
  return {
    weekday: out.weekday,
    month: out.month,
    day: Number(out.day),
    year: Number(out.year),
    hour: Number(out.hour),
    minute: Number(out.minute),
  };
}

// "Tue Oct 14, 9:41 PM"
export function formatStamp(ts, timeZone) {
  const p = localParts(ts, timeZone);
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  const ampm = p.hour < 12 ? 'AM' : 'PM';
  return `${p.weekday} ${p.month} ${p.day}, ${h12}:${String(p.minute).padStart(2, '0')} ${ampm}`;
}

export function inWindow(ts, timeZone, startHour, endHour) {
  if (startHour === endHour) return true; // "any time"
  const { hour } = localParts(ts, timeZone);
  return startHour < endHour ? hour >= startHour && hour < endHour : hour >= startHour || hour < endHour;
}

// First moment at or after `ts` that falls inside the local active window (10-minute resolution).
export function nextWindowStart(ts, timeZone, startHour, endHour) {
  const step = 10 * 60 * 1000;
  let t = ts;
  for (let i = 0; i < (8 * 24 * 60) / 10; i++) {
    if (inWindow(t, timeZone, startHour, endHour)) return t;
    t += step;
  }
  return ts;
}

export function windowLengthHours(startHour, endHour) {
  if (startHour === endHour) return 24;
  return startHour < endHour ? endHour - startHour : 24 - startHour + endHour;
}

export function describeGap(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}
