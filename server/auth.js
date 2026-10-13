import crypto from 'node:crypto';
import { config } from './config.js';

// Single access code (set with the ACCESS_CODE env var). Logging in sets a long-lived,
// HttpOnly cookie derived from the code — change the code and every old session stops working.

const COOKIE = 'mochi_session';
const ONE_YEAR = 365 * 24 * 60 * 60;

const sessionToken = () =>
  crypto.createHmac('sha256', config.accessCode).update('mochi-session-v1').digest('base64url');

// Identifies the current login without revealing the cookie; push subscriptions are tagged with it, so changing
// the access code also stops notifications to devices registered under the old one.
export const sessionId = () => crypto.createHash('sha256').update(sessionToken()).digest('hex').slice(0, 32);

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function isAuthed(req) {
  const token = readCookie(req, COOKIE);
  return Boolean(token) && safeEqual(token, sessionToken());
}

export function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: 'not_logged_in' });
}

// Slow down guessing: 10 wrong codes per IP, and 30 overall, per 15 minutes.
// (The overall cap matters because client IPs behind a hosting proxy can be spoofed.)
const WINDOW = 15 * 60 * 1000;
const attempts = new Map();
let globalFailures = { count: 0, resetAt: 0 };

function bucket(map, key, now) {
  let b = map.get(key);
  if (!b || b.resetAt < now) {
    b = { count: 0, resetAt: now + WINDOW };
    map.set(key, b);
  }
  return b;
}

function tooManyAttempts(ip) {
  const now = Date.now();
  if (globalFailures.resetAt < now) globalFailures = { count: 0, resetAt: now + WINDOW };
  return globalFailures.count >= 30 || bucket(attempts, ip, now).count >= 10;
}

function recordFailure(ip) {
  bucket(attempts, ip, Date.now()).count++;
  globalFailures.count++;
}

export function login(req, res) {
  const ip = req.ip || 'unknown';
  if (tooManyAttempts(ip)) return res.status(429).json({ error: 'Too many tries. Wait 15 minutes and try again.' });
  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
  if (!code || !safeEqual(code, config.accessCode)) {
    recordFailure(ip);
    return setTimeout(() => res.status(401).json({ error: "That code didn't match." }), 400);
  }
  attempts.delete(ip);
  const secure = req.secure ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${sessionToken()}; Path=/; Max-Age=${ONE_YEAR}; HttpOnly; SameSite=Lax${secure}`,
  );
  res.json({ ok: true });
}

export function logout(req, res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
  // Also forget cached photos and files, so they can't be reopened from the browser's history.
  res.setHeader('Clear-Site-Data', '"cache"');
  res.json({ ok: true });
}
