// Push notifications for the Cloudflare version (see webpush.js for the protocol details).
import { generateVapidKeys, sendWebPush } from './webpush.js';
import { pushPayload, vapidSubject, PUSH_TTL } from '../server/push-payload.js';

// VAPID keys: the VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY secrets if set, otherwise generated once and kept in D1.
export async function vapidKeys(store, env = {}) {
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
  const saved = await store.get('vapid');
  if (saved) return saved;
  await store.putIfAbsent('vapid', await generateVapidKeys());
  return store.get('vapid'); // re-read: if two requests raced, everyone uses the winner
}

// Send to every registered device; drops subscriptions the push service says are gone. Returns how many got it.
export async function notifyAll(env, store, { title, body, tag = 'mochi' }) {
  const subs = await store.pushSubscriptions();
  if (!subs.length) return 0;
  const origin = (env.PUBLIC_URL || (await store.get('origin')) || '').replace(/\/+$/, '');
  const vapid = await vapidKeys(store, env);
  const sub = vapidSubject(env.VAPID_SUBJECT, origin);
  const payload = pushPayload({ title, body, tag, origin });
  let delivered = 0;
  await Promise.all(
    subs.map(async (s) => {
      try {
        const r = await sendWebPush(s, payload, { vapid, subject: sub, ttl: PUSH_TTL });
        if (r.ok) delivered++;
        else if (r.gone) await store.removePushSubscription(s.endpoint);
        else console.error('Push failed:', r.status, r.detail);
      } catch (err) {
        console.error('Push failed:', err?.message || err);
      }
    }),
  );
  return delivered;
}
