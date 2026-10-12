// Web Push using only WebCrypto, so it runs on Cloudflare Workers (the web-push npm package needs Node's
// http and ECDH APIs). Implements message encryption (RFC 8291, "aes128gcm") and VAPID sender
// authentication (RFC 8292).

const encoder = new TextEncoder();

export function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (str.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}

// Same format as the web-push package: base64url raw public key (65 bytes) and private scalar (32 bytes).
export async function generateVapidKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const { d } = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { publicKey: b64url(publicKey), privateKey: d };
}

async function importSigningKey({ publicKey, privateKey }) {
  const pub = fromB64url(publicKey);
  const jwk = { kty: 'EC', crv: 'P-256', x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33, 65)), d: privateKey, ext: true };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

// RFC 8292: a short-lived ES256 JWT for the push service's origin.
export async function vapidAuthorization(endpoint, vapid, subject, now = Date.now()) {
  const header = b64url(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = { aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 60 * 60, sub: subject };
  const payload = b64url(encoder.encode(JSON.stringify(claims)));
  const key = await importSigningKey(vapid);
  // WebCrypto returns the raw r||s signature, which is exactly what a JWS ES256 signature is.
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(`${header}.${payload}`)));
  return `vapid t=${header}.${payload}.${b64url(signature)}, k=${vapid.publicKey}`;
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

// RFC 8291 + RFC 8188: encrypt one record for the browser's subscription keys.
export async function encryptPayload(subscription, plaintext) {
  const uaPublic = fromB64url(subscription.keys.p256dh);
  const authSecret = fromB64url(subscription.keys.auth);
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error('Bad subscription keys');

  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));

  const keyInfo = concat(encoder.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 12);

  // A single (and therefore last) record: the plaintext followed by the 0x02 delimiter.
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, concat(plaintext, new Uint8Array([2]))),
  );

  // Header: salt (16) | record size (uint32) | key id length (1) | key id = our public key (65)
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, sealed);
}

// Sends one notification. Returns { ok, status, gone } — gone means the subscription should be deleted.
export async function sendWebPush(subscription, payload, { vapid, subject, ttl = 6 * 60 * 60, urgency = 'normal', topic } = {}) {
  const data = encoder.encode(typeof payload === 'string' ? payload : JSON.stringify(payload));
  if (data.length > 3000) throw new Error('Push payload too large');
  const body = await encryptPayload(subscription, data);
  const headers = {
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(ttl),
    Urgency: urgency,
    Authorization: await vapidAuthorization(subscription.endpoint, vapid, subject),
  };
  if (topic) headers.Topic = topic.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  const res = await fetch(subscription.endpoint, { method: 'POST', headers, body });
  const detail = res.ok ? '' : await res.text().catch(() => '');
  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410, detail };
}
