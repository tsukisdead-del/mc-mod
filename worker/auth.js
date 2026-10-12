// Access-code lock for the Cloudflare version.
// - If the ACCESS_CODE secret is set, it works exactly like the Node server.
// - Otherwise the first person to open the app chooses the code (stored salted and hashed in D1).
// Either way a long-lived HttpOnly cookie keeps each device unlocked.

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

export async function loadAuth(env, store) {
  if (env.ACCESS_CODE) return { mode: 'env', code: env.ACCESS_CODE };
  const saved = await store.get('auth');
  return saved ? { mode: 'stored', ...saved } : { mode: 'setup' };
}

async function sessionToken(auth) {
  if (auth.mode === 'env') return hmac(auth.code, 'mochi-session-v1');
  if (auth.mode === 'stored') return hmac(auth.sessionSecret, 'mochi-session-v1');
  return null;
}

export async function isAuthed(request, auth) {
  const token = readCookie(request, COOKIE);
  const expected = await sessionToken(auth);
  if (!token || !expected) return false;
  return safeEqual(token, expected);
}

function sessionCookie(token) {
  return `${COOKIE}=${token}; Path=/; Max-Age=${ONE_YEAR}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

// Global failed-attempt limit (per-IP limits are easy to dodge): 30 wrong codes per 15 minutes.
const WINDOW = 15 * 60 * 1000;
async function tooManyFailures(store) {
  const f = await store.get('login_failures', { count: 0, resetAt: 0 });
  return f.resetAt > Date.now() && f.count >= 30;
}
async function recordFailure(store) {
  const now = Date.now();
  const f = await store.get('login_failures', { count: 0, resetAt: 0 });
  await store.put('login_failures', f.resetAt > now ? { ...f, count: f.count + 1 } : { count: 1, resetAt: now + WINDOW });
}

// Returns { status, body, cookie? }.
export async function login(code, auth, store) {
  if (auth.mode === 'setup') return { status: 409, body: { error: 'No access code yet. Reload the page to create one.' } };
  if (await tooManyFailures(store)) return { status: 429, body: { error: 'Too many tries. Wait 15 minutes and try again.' } };
  const ok =
    typeof code === 'string' &&
    code.trim() !== '' &&
    (auth.mode === 'env' ? await safeEqual(code.trim(), auth.code) : await safeEqual(await sha256(auth.salt + code.trim()), auth.hash));
  if (!ok) {
    await recordFailure(store);
    return { status: 401, body: { error: "That code didn't match." } };
  }
  return { status: 200, body: { ok: true }, cookie: sessionCookie(await sessionToken(auth)) };
}

// First run only: the first visitor picks the access code.
export async function setup(code, auth, store) {
  if (auth.mode !== 'setup') return { status: 409, body: { error: 'An access code already exists. Reload to unlock.' } };
  const clean = typeof code === 'string' ? code.trim() : '';
  if (clean.length < 8) return { status: 400, body: { error: 'Use at least 8 characters.' } };
  const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
  const record = { salt, hash: await sha256(salt + clean), sessionSecret: toHex(crypto.getRandomValues(new Uint8Array(32))) };
  // If two people race, only the first insert wins.
  if (!(await store.putIfAbsent('auth', record))) return { status: 409, body: { error: 'An access code already exists. Reload to unlock.' } };
  return { status: 200, body: { ok: true }, cookie: sessionCookie(await sessionToken({ mode: 'stored', ...record })) };
}
