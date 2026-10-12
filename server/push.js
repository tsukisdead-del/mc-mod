import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import { config } from './config.js';
import { state, save } from './store.js';
import { plainText } from '../public/js/reply-format.js';
import { pushPayload, vapidSubject, PUSH_TTL } from './push-payload.js';

// VAPID keys identify this server to Apple/Google push services. Use env vars if given,
// otherwise generate a pair once and keep it in the data folder.
function loadVapidKeys() {
  if (config.vapidPublicKey && config.vapidPrivateKey) {
    return { publicKey: config.vapidPublicKey, privateKey: config.vapidPrivateKey };
  }
  const file = path.join(config.dataDir, 'vapid.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    const keys = webpush.generateVAPIDKeys();
    fs.writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
    return keys;
  }
}

const vapid = loadVapidKeys();

export const vapidPublicKey = vapid.publicKey;

export function addSubscription(sub, userAgent) {
  if (!sub || typeof sub.endpoint !== 'string' || !sub.keys?.p256dh || !sub.keys?.auth) {
    throw new Error('Invalid push subscription');
  }
  if (!/^https:\/\//.test(sub.endpoint)) throw new Error('Invalid push endpoint');
  state.pushSubscriptions = state.pushSubscriptions.filter((s) => s.endpoint !== sub.endpoint);
  state.pushSubscriptions.push({
    endpoint: sub.endpoint,
    keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    userAgent: String(userAgent || '').slice(0, 200),
    createdAt: Date.now(),
  });
  save();
}

export function removeSubscription(endpoint) {
  state.pushSubscriptions = state.pushSubscriptions.filter((s) => s.endpoint !== endpoint);
  save();
}

// The app's https address: PUBLIC_URL, or what the browser last used to reach us (see /api/state).
function appOrigin() {
  return config.publicUrl || state.origin || '';
}

// Send a notification to every registered device. Returns how many got it.
export async function notifyAll({ title, body, tag = 'mochi' }) {
  const origin = appOrigin();
  const payload = JSON.stringify(pushPayload({ title, body, tag, origin }));
  const options = {
    TTL: PUSH_TTL,
    urgency: 'normal',
    vapidDetails: { subject: vapidSubject(config.vapidSubject, origin), publicKey: vapid.publicKey, privateKey: vapid.privateKey },
  };
  let delivered = 0;
  await Promise.all(
    state.pushSubscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, payload, options);
        delivered++;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) removeSubscription(sub.endpoint);
        else console.error('Push failed:', err.statusCode || '', err.body || err.message);
      }
    }),
  );
  return delivered;
}

export function notifyMessage(raw, tag) {
  return notifyAll({ title: state.settings.therapistName, body: plainText(raw) || 'New message', tag });
}
