// Notification details shared by the Node server and the Cloudflare Worker.

// Payload in the Declarative Web Push shape: iPhones on iOS 18.4+ show it even without running the
// service worker. public/sw.js reads the same shape on older iPhones and other browsers.
export function pushPayload({ title, body, tag = 'mochi', origin }) {
  const notification = { title: String(title || 'Dr. Mochi'), body: String(body || 'New message').slice(0, 240), tag, app_badge: 1 };
  if (!origin) return { notification };
  return { web_push: 8030, notification: { ...notification, navigate: `${origin.replace(/\/+$/, '')}/` } };
}

// VAPID "sub" claim. Apple rejects placeholders (localhost, .local, .invalid, example.com) with 403
// BadJwtToken, so prefer the app's own https address.
export const FALLBACK_SUBJECT = 'https://github.com/tsukisdead-del/mc-mod';

export function vapidSubject(configured, origin) {
  if (configured) return configured;
  if (origin && /^https:\/\//.test(origin)) return origin.replace(/\/+$/, '');
  return FALLBACK_SUBJECT;
}

// Push messages last 6 hours if the phone is offline. No Topic header: Apple's push service has been
// rejecting every request that carries one (400 BadWebPushTopic) since September 2026.
export const PUSH_TTL = 6 * 60 * 60;
