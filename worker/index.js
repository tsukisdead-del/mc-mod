// Dr. Mochi on Cloudflare Workers (free plan): same /api contract as the Node server, so the same
// frontend in /public works unchanged. Storage is D1 + KV, the AI is Workers AI (free daily allowance)
// unless an ANTHROPIC_API_KEY secret is added, and check-ins run from a Cron Trigger.
import { Buffer } from 'node:buffer';
import QRCode from 'qrcode';
import { Store, publicMessage } from './store.js';
import { hasCode, isAuthed, login, clearCookie, sessionId, LOGIN_KEY_PREFIX } from './auth.js';
import { createAI, friendlyMessage } from './ai.js';
import { handleUpload } from './files.js';
import { notifyAll, vapidKeys } from './push.js';
import { applySettingsPatch, FREQUENCIES } from '../server/settings.js';
import { scheduleNext, noteActivity, tickAction, HOUR, MAX_UNANSWERED } from '../server/checkins.js';
import { buildMobileConfig } from '../server/profile.js';
import { isPushEndpoint } from '../server/push-payload.js';
import { parseReply, plainText } from '../public/js/reply-format.js';

const encoder = new TextEncoder();
const PAGE = 120;
// One reply is written at a time. The lock expires on its own in case a Worker is stopped mid-reply.
const REPLY_LOCK = 'replying';
const REPLY_LOCK_MS = 3 * 60 * 1000;
// How long a second request waits for the first reply to finish (seconds between checks; D1 allows 50 queries).
const LOCK_WAITS = [1, 2, 3, 4, 5, 5, 5, 5, 5, 5, 5, 5, 5];
// Photos are resized in the browser to at most this many pixels on the long side before upload.
const PHOTO_MAX_SIDE = { 'workers-ai': 1024 };

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function withHeaders(response, extra = {}) {
  const res = new Response(response.body, response);
  for (const [k, v] of Object.entries({ ...SECURITY_HEADERS, ...extra })) res.headers.set(k, v);
  return res;
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...headers },
  });
}

function appOrigin(request, env) {
  return (env.PUBLIC_URL || new URL(request.url).origin).replace(/\/+$/, '');
}

function checkinStatus(state) {
  return {
    nextAt: state.checkin.nextAt,
    lastSentAt: state.checkin.lastSentAt,
    paused: state.settings.checkins.enabled && state.checkin.unanswered >= MAX_UNANSWERED,
  };
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

// ---------- Check-ins ----------

async function sendCheckin(env, store, state, { manual }) {
  if (!manual) {
    // Claim the slot first so an overlapping cron run can't send a second one.
    state.checkin.nextAt = Date.now() + HOUR;
    await store.saveState(state, ['checkin']);
  }
  const ai = createAI(env, store);
  const raw = await ai.checkin(state);
  if (!raw) throw new Error('No check-in text was generated');
  const parsed = parseReply(raw);
  const msg = await store.addMessage({ role: 'assistant', kind: 'checkin', text: raw, mood: parsed.mood, crisis: parsed.crisis });
  state.checkin.lastSentAt = msg.createdAt;
  if (!manual) {
    state.checkin.unanswered++;
    state.checkin.nextAt = scheduleNext(state.settings, state.checkin, Date.now());
  }
  await store.saveState(state, ['checkin']);
  await notifyAll(env, store, { title: state.settings.therapistName, body: plainText(raw) || 'New message', tag: 'checkin' });
  return msg;
}

async function checkinTick(env) {
  const store = await new Store(env).init();
  await store.dropExpired(LOGIN_KEY_PREFIX);
  const state = await store.loadState();
  const now = Date.now();
  const action = tickAction({ settings: state.settings, checkin: state.checkin, lastUserMessageAt: state.lastUserMessageAt, now });
  if (action === 'wait') return;
  if (action !== 'send') {
    state.checkin.nextAt = scheduleNext(state.settings, state.checkin, action.reschedule);
    await store.saveState(state, ['checkin']);
    return;
  }
  try {
    await sendCheckin(env, store, state, { manual: false });
  } catch (err) {
    console.error('Check-in failed:', err?.message || err);
    state.checkin.nextAt = now + HOUR; // try again later
    await store.saveState(state, ['checkin']);
  }
}

// ---------- Chat (server-sent events) ----------

async function handleChat(request, env, ctx, store) {
  const body = await readJson(request);
  const items = Array.isArray(body?.items) ? body.items.slice(0, 10) : [];
  const wanted = items.flatMap((it) => (Array.isArray(it?.attachmentIds) ? it.attachmentIds.slice(0, 10) : []));
  const known = await store.attachmentMap(wanted);
  const clean = [];
  for (const it of items) {
    const text = typeof it?.text === 'string' ? it.text.trim().slice(0, 8000) : '';
    const ids = Array.isArray(it?.attachmentIds) ? it.attachmentIds.filter((id) => known[id]).slice(0, 10) : [];
    if (text || ids.length) clean.push({ text, ids });
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  let open = true;
  const send = async (event, data) => {
    if (!open) return;
    try {
      await writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    } catch {
      open = false; // they closed the app; keep going so the reply is saved
    }
  };
  const keepAlive = setInterval(() => open && writer.write(encoder.encode(': ping\n\n')).catch(() => (open = false)), 15000);

  const work = (async () => {
    const ai = createAI(env, store);
    let state;
    let lock = null;
    try {
      state = await store.loadState();
      const saved = await store.addMessages(clean.map((c) => ({ role: 'user', text: c.text, attachments: c.ids })));
      if (saved.length) {
        const now = Date.now();
        state.lastUserMessageAt = now;
        if (noteActivity(state.checkin, now)) state.checkin.nextAt = scheduleNext(state.settings, state.checkin, now);
        await store.saveState(state, ['checkin', 'meta']);
        await send('saved', { messages: saved.map((m) => publicMessage(m, known)) });
      }
      // Another request is still replying (say they sent more after the app lost its connection): wait for it,
      // then answer what's still unanswered with that reply in view.
      lock = await store.lease(REPLY_LOCK, REPLY_LOCK_MS);
      const waited = !lock;
      for (const s of LOCK_WAITS) {
        if (lock) break;
        await send('typing', {});
        await sleep(s);
        lock = await store.lease(REPLY_LOCK, REPLY_LOCK_MS);
      }
      if (!lock) {
        await send('error', { error: "I'm still finishing my last reply. Give me a moment, then tap Try again." });
        return;
      }
      const last = await store.lastMessage();
      if (last?.role !== 'user') {
        await send('done', { message: null, catchUp: waited });
        return;
      }
      if (waited) state = await store.loadState();
      await send('typing', {});
      const { raw, reset, risk, answers } = await ai.reply(state, (t) => send('delta', { t }));
      const parsed = parseReply(raw);
      const reply = await store.addMessage({ role: 'assistant', text: raw, mood: parsed.mood, crisis: parsed.crisis || risk }, { after: answers });
      await send('done', { message: publicMessage(reply, {}), reset: Boolean(reset), catchUp: waited });
      // They closed the app before the reply finished: text them like a normal messaging app would.
      if (!open && state.settings.checkins.replyNotifications) {
        await notifyAll(env, store, { title: state.settings.therapistName, body: plainText(raw), tag: 'reply' });
      }
    } catch (err) {
      console.error('Chat failed:', err?.message || err);
      await send('error', { error: friendlyMessage(err, state?.settings.timezone) });
    } finally {
      if (lock) await store.release(REPLY_LOCK, lock).catch((err) => console.error('Unlock failed:', err?.message || err));
      clearInterval(keepAlive);
      try {
        await writer.close();
      } catch {
        // already closed
      }
    }
    if (state) await ai.maybeUpdateMemory(state).catch((err) => console.error('Memory update failed:', err?.message || err));
  })();
  ctx.waitUntil(work);

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      ...SECURITY_HEADERS,
    },
  });
}

// ---------- API ----------

async function api(request, env, ctx, url) {
  const store = await new Store(env).init();
  const path = url.pathname;
  const method = request.method;

  if (path === '/api/health') return json({ ok: true });

  if (path === '/api/me') {
    const settings = (await store.loadState()).settings;
    return json({ authed: await isAuthed(request, env), name: settings.therapistName, needsCode: !hasCode(env) });
  }
  if (path === '/api/login' && method === 'POST') {
    const r = await login(request, (await readJson(request)).code, env, store);
    return json(r.body, r.status, r.cookie ? { 'Set-Cookie': r.cookie } : {});
  }
  // Also forget cached photos and files, so they can't be reopened from the browser's history.
  if (path === '/api/logout' && method === 'POST') return json({ ok: true }, 200, { 'Set-Cookie': clearCookie(), 'Clear-Site-Data': '"cache"' });

  if (!(await isAuthed(request, env))) return json({ error: 'not_logged_in' }, 401);
  const session = await sessionId(env);

  if (path === '/api/state' && method === 'GET') {
    const [state, page, devices, keys] = await Promise.all([
      store.loadState(),
      store.listMessages({ limit: PAGE }),
      store.countPushSubscriptions(session),
      vapidKeys(store, env),
    ]);
    // Remember the app's address so scheduled check-ins can sign push messages with it.
    const origin = appOrigin(request, env);
    if ((await store.get('origin')) !== origin) await store.put('origin', origin);
    const atts = await store.attachmentMap(page.messages.flatMap((m) => m.attachments));
    const ai = createAI(env, store);
    return json({
      settings: state.settings,
      frequencies: Object.fromEntries(Object.entries(FREQUENCIES).map(([k, v]) => [k, v.label])),
      messages: page.messages.map((m) => publicMessage(m, atts)),
      hasMore: page.hasMore,
      memory: { text: state.memory.text, updatedAt: state.memory.updatedAt },
      push: { publicKey: keys.publicKey, devices },
      checkin: checkinStatus(state),
      server: {
        demo: ai.provider === 'mock',
        hasApiKey: true,
        provider: ai.provider,
        model: ai.model,
        modelLabel: ai.modelLabel,
        transcribe: ai.canTranscribe,
        photoMaxSide: PHOTO_MAX_SIDE[ai.provider],
        usage: ai.provider === 'workers-ai' ? await ai.usageToday() : null,
      },
    });
  }

  if (path === '/api/usage' && method === 'GET') return json(await createAI(env, store).usageToday());

  if (path === '/api/messages' && method === 'GET') {
    const after = Number(url.searchParams.get('after')) || 0;
    const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER;
    const page = await store.listMessages({ after, before, limit: PAGE, oldestFirst: Boolean(after) });
    const atts = await store.attachmentMap(page.messages.flatMap((m) => m.attachments));
    return json({ messages: page.messages.map((m) => publicMessage(m, atts)), hasMore: page.hasMore });
  }

  if (path === '/api/messages' && method === 'DELETE') {
    await store.deleteAllMessages();
    const state = await store.loadState();
    state.historyStart = 0;
    await store.saveState(state, ['meta']);
    return json({ ok: true });
  }

  if (path === '/api/settings' && method === 'PUT') {
    const state = await store.loadState();
    const before = state.settings;
    state.settings = applySettingsPatch(before, await readJson(request));
    const a = before.checkins;
    const b = state.settings.checkins;
    const parts = ['settings'];
    if (a.enabled !== b.enabled || a.frequency !== b.frequency || a.startHour !== b.startHour || a.endHour !== b.endHour || before.timezone !== state.settings.timezone) {
      if (b.enabled && !a.enabled) state.checkin.unanswered = 0;
      state.checkin.nextAt = scheduleNext(state.settings, state.checkin, Date.now());
      parts.push('checkin');
    }
    await store.saveState(state, parts);
    return json({ settings: state.settings, checkin: checkinStatus(state) });
  }

  if (path === '/api/upload' && method === 'POST') {
    const r = await handleUpload(request, env, store);
    return json(r.body, r.status);
  }

  const attachment = path.match(/^\/api\/attachments\/([a-z0-9]+)$/);
  if (attachment && method === 'GET') {
    const id = attachment[1];
    // A file never changes, but the browser checks back each time so a locked app can't show it from cache.
    const etag = `"${id}"`;
    const cache = { 'Cache-Control': 'private, no-cache', ETag: etag };
    if (request.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers: { ...cache, ...SECURITY_HEADERS } });
    const data = (await store.fileData([id]))[id];
    // Without the original (big documents, text files), show the text that was read from it.
    const meta = (await store.attachmentMap([id], { text: !data }))[id];
    if (!meta) return new Response('Not found', { status: 404 });
    const body = data ? Buffer.from(data, 'base64') : meta.text || '';
    return new Response(body, {
      headers: {
        'Content-Type': data ? meta.mime : 'text/plain; charset=utf-8',
        ...cache,
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(data ? meta.name : `${meta.name}.txt`)}`,
        ...SECURITY_HEADERS,
        'Content-Security-Policy': 'sandbox',
      },
    });
  }

  if (path === '/api/chat' && method === 'POST') return handleChat(request, env, ctx, store);

  if (path === '/api/transcribe' && method === 'POST') {
    const ai = createAI(env, store);
    if (!ai.canTranscribe) return json({ error: "Voice transcription isn't available." }, 400);
    const audio = await request.arrayBuffer();
    if (!audio.byteLength) return json({ error: "I didn't catch any audio." }, 400);
    if (audio.byteLength > 10 * 1024 * 1024) return json({ error: 'That recording is too long. Try a shorter one.' }, 400);
    try {
      return json({ text: await ai.transcribe(audio, request.headers.get('Content-Type') || '') });
    } catch (err) {
      console.error('Transcription failed:', err?.message || err);
      return json({ error: friendlyMessage(err, (await store.loadState()).settings.timezone) }, 500);
    }
  }

  if (path === '/api/memory' && method === 'PUT') {
    const state = await store.loadState();
    const text = (await readJson(request)).text;
    state.memory.text = typeof text === 'string' ? text.slice(0, 6000).trim() : '';
    state.memory.updatedAt = Date.now();
    await store.saveState(state, ['memory']);
    return json({ memory: { text: state.memory.text, updatedAt: state.memory.updatedAt } });
  }

  if (path === '/api/memory/refresh' && method === 'POST') {
    const state = await store.loadState();
    await createAI(env, store).maybeUpdateMemory(state, { force: true });
    return json({ memory: { text: state.memory.text, updatedAt: state.memory.updatedAt } });
  }

  if (path === '/api/push/subscribe' && method === 'POST') {
    const sub = (await readJson(request)).subscription;
    if (!sub || typeof sub.endpoint !== 'string' || typeof sub.keys?.p256dh !== 'string' || typeof sub.keys?.auth !== 'string') {
      return json({ error: 'Invalid push subscription' }, 400);
    }
    if (!isPushEndpoint(sub.endpoint)) return json({ error: "That browser's notification service isn't supported." }, 400);
    await store.addPushSubscription(sub, request.headers.get('User-Agent'), session);
    return json({ ok: true, devices: await store.countPushSubscriptions(session) });
  }

  if (path === '/api/push/unsubscribe' && method === 'POST') {
    const { endpoint } = await readJson(request);
    if (typeof endpoint === 'string') await store.removePushSubscription(endpoint);
    return json({ ok: true, devices: await store.countPushSubscriptions(session) });
  }

  if (path === '/api/push/test' && method === 'POST') {
    const state = await store.loadState();
    const delivered = await notifyAll(env, store, {
      title: state.settings.therapistName,
      body: "Notifications are working! This is how I'll check in on you. 💛",
      tag: 'test',
    });
    return json({ delivered });
  }

  if (path === '/api/checkin' && method === 'POST') {
    const state = await store.loadState();
    try {
      const msg = await sendCheckin(env, store, state, { manual: true });
      return json({ message: publicMessage(msg, {}), checkin: checkinStatus(state) });
    } catch (err) {
      console.error('Manual check-in failed:', err?.message || err);
      return json({ error: friendlyMessage(err, state.settings.timezone) }, 500);
    }
  }

  return json({ error: 'not_found' }, 404);
}

// ---------- Public, non-API routes ----------

async function iconBase64(env, request) {
  const res = await env.ASSETS.fetch(new Request(new URL('/icons/apple-touch-icon.png', request.url)));
  return Buffer.from(await res.arrayBuffer()).toString('base64');
}

async function special(request, env, url) {
  const path = url.pathname;
  if (path === '/app.mobileconfig' || path === '/install.mobileconfig') {
    const store = await new Store(env).init();
    const { settings } = await store.loadState();
    const label = settings.therapistName;
    const body = buildMobileConfig({ url: appOrigin(request, env), label, iconBase64: await iconBase64(env, request) });
    const filename = label.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '') || 'therapist';
    return new Response(body, {
      headers: {
        'Content-Type': 'application/x-apple-aspen-config',
        'Content-Disposition': `attachment; filename="${filename}.mobileconfig"`,
        'Cache-Control': 'no-store',
        ...SECURITY_HEADERS,
      },
    });
  }
  if (path === '/install-qr.svg') {
    // Generating a QR code is CPU-heavy for the free plan's 10 ms budget, so make it once per address.
    const store = await new Store(env).init();
    const target = `${appOrigin(request, env)}/install`;
    const cached = await store.get('install_qr');
    let svg = cached?.target === target ? cached.svg : null;
    if (!svg) {
      svg = await QRCode.toString(target, { type: 'svg', margin: 1, color: { dark: '#2b2233', light: '#ffffff' } });
      await store.put('install_qr', { target, svg });
    }
    return new Response(svg, { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache', ...SECURITY_HEADERS } });
  }
  if (path === '/manifest.webmanifest') {
    const store = await new Store(env).init();
    const name = (await store.loadState()).settings.therapistName;
    return json(
      {
        name,
        short_name: name.length > 12 ? name.replace(/^Dr\.?\s+/i, '') : name,
        description: `Text with ${name}, your cartoon AI therapist.`,
        id: '/',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#FFF7F0',
        theme_color: '#FFF7F0',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      200,
      { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' },
    );
  }
  return null;
}

async function assets(request, env, url) {
  let res = await env.ASSETS.fetch(request);
  // Unknown app paths (no file extension) fall back to the app shell.
  if (res.status === 404 && request.method === 'GET' && !/\.[a-z0-9]+$/i.test(url.pathname)) {
    res = await env.ASSETS.fetch(new Request(new URL('/', url), request));
  }
  return withHeaders(res, { 'Cache-Control': 'no-cache' });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) return await api(request, env, ctx, url);
      return (await special(request, env, url)) || (await assets(request, env, url));
    } catch (err) {
      console.error('Request failed:', err?.stack || err);
      return json({ error: 'Something went wrong on the server.' }, 500);
    }
  },

  // Cron Trigger: decide whether it's time to text them first.
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(checkinTick(env));
  },
};
