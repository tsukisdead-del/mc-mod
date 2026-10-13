// Access-code lock for the Cloudflare version. The code is the ACCESS_CODE secret, set in the Cloudflare
// dashboard (nobody can claim the app before you do); until it exists the app explains how to add it.
// A long-lived HttpOnly cookie keeps each device unlocked. Changing the code logs every device out.

const COOKIE = 'mochi_session';
const ONE_YEAR = 365 * 24 * 60 * 60;
const encoder = new TextEncoder();

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256(text) {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

// Constant-time comparison of two strings (hash first so lengths match).
async function safeEqual(a, b) {
  const [ha, hb] = await Promise.all([crypto.subtle.digest('SHA-256', encoder.encode(String(a))), crypto.subtle.digest('SHA-256', encoder.encode(String(b)))]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function readCookie(request, name) {
  for (const part of (request.headers.get('Cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function hasCode(env) {
  return Boolean(String(env.ACCESS_CODE || '').trim());
}

function accessCode(env) {
  return String(env.ACCESS_CODE || '').trim();
}

async function sessionToken(env) {
  return hasCode(env) ? hmac(accessCode(env), 'mochi-session-v1') : null;
}

// Identifies the current login without revealing the cookie; push subscriptions are tagged with it.
export async function sessionId(env) {
  const token = await sessionToken(env);
  return token ? (await sha256(token)).slice(0, 32) : null;
}

export async function isAuthed(request, env) {
  const token = readCookie(request, COOKIE);
  const expected = await sessionToken(env);
  if (!token || !expected) return false;
  return safeEqual(token, expected);
}

function sessionCookie(token) {
  return `${COOKIE}=${token}; Path=/; Max-Age=${ONE_YEAR}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

// Guessing limits, counted atomically in D1 (each try is counted before the code is checked, and given back
// when it was right): 10 tries per address and 100 overall per 15 minutes.
const WINDOW = 15 * 60 * 1000;
const PER_ADDRESS = 10;
const OVERALL = 100;
export const LOGIN_KEY_PREFIX = 'login:';

// Cloudflare sets CF-Connecting-IP itself, so it can't be faked. IPv6 users usually have a whole /64.
export function addressBucket(ip) {
  if (!ip) return 'unknown';
  if (!ip.includes(':')) return ip;
  const [head, tail] = ip.toLowerCase().split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

// Returns { status, body, cookie? }.
export async function login(request, code, env, store) {
  if (!hasCode(env)) return { status: 409, body: { error: 'Add the ACCESS_CODE secret in Cloudflare first.' } };
  const keys = [`${LOGIN_KEY_PREFIX}${addressBucket(request.headers.get('CF-Connecting-IP'))}`, `${LOGIN_KEY_PREFIX}all`];
  const [mine, all] = await Promise.all(keys.map((k) => store.bump(k, WINDOW)));
  if (mine > PER_ADDRESS || all > OVERALL) return { status: 429, body: { error: 'Too many tries. Wait 15 minutes and try again.' } };
  const ok = typeof code === 'string' && code.trim() !== '' && (await safeEqual(code.trim(), accessCode(env)));
  if (!ok) return { status: 401, body: { error: "That code didn't match." } };
  await Promise.all(keys.map((k) => store.bump(k, WINDOW, -1)));
  return { status: 200, body: { ok: true }, cookie: sessionCookie(await sessionToken(env)) };
}
