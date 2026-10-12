// Service worker: offline app shell, push notifications (check-ins), and the app badge.
const CACHE = 'mochi-shell-v2';
const SHELL = [
  '/',
  '/styles.css',
  '/js/app.js',
  '/js/api.js',
  '/js/avatar.js',
  '/js/markdown.js',
  '/js/voice.js',
  '/js/reply-format.js',
  '/icons/icon-192.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network first (so updates show up right away), cache as the offline fallback. API calls are never cached.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && SHELL.includes(url.pathname)) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('/') : undefined))),
  );
});

// Payloads use the Declarative Web Push shape ({ web_push: 8030, notification: {...} }). iOS 18.4+ shows those
// by itself; everywhere else this handler does. Older payloads were flat { title, body, tag, url }.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const n = data.notification || data;
  event.waitUntil(
    (async () => {
      await self.registration.showNotification(n.title || 'Dr. Mochi', {
        body: n.body || 'New message',
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        tag: n.tag || 'mochi',
        renotify: true,
        data: { url: n.navigate || n.url || '/' },
      });
      if (self.navigator.setAppBadge) await self.navigator.setAppBadge(n.app_badge || 1).catch(() => {});
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) client.postMessage({ type: 'push' });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        if (client.url.startsWith(self.location.origin)) {
          client.postMessage({ type: 'push' });
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })(),
  );
});
