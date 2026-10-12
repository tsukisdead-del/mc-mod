import express from 'express';
import multer from 'multer';
import QRCode from 'qrcode';
import path from 'node:path';
import { config } from './config.js';
import { state, save, flush, addMessage, publicMessage } from './store.js';
import { requireAuth, login, logout, isAuthed } from './auth.js';
import { applySettingsPatch, FREQUENCIES } from './settings.js';
import { saveUpload, UploadError, attachmentPath, deleteAllAttachments } from './attachments.js';
import { generateReply, maybeUpdateMemory, friendlyMessage } from './ai.js';
import { vapidPublicKey, addSubscription, removeSubscription, notifyAll, notifyMessage } from './push.js';
import { startScheduler, reschedule, noteUserActivity, sendCheckinNow } from './scheduler.js';
import { buildMobileConfig, defaultIconPath } from './profile.js';
import { withLock } from './lock.js';
import { parseReply, plainText } from '../public/js/reply-format.js';

if (!config.accessCode) {
  console.error(
    '\nACCESS_CODE is not set. Pick a private code (like a password) and set it as an environment variable,\n' +
      'e.g. ACCESS_CODE=my-secret-code npm start  (or put it in a .env file). You type it once on your phone to unlock the app.\n',
  );
  process.exit(1);
}

if (config.accessCode.length < 8) {
  console.warn('Warning: ACCESS_CODE is short. Anyone who guesses it can read your chats, so use 8+ characters.');
}

const app = express();
app.set('trust proxy', true); // behind Render/Railway/Fly proxies, so req.secure and req.ip are right
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  next();
});
app.use(express.json({ limit: '1mb' }));

// ---------- Public routes ----------

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.post('/api/login', login);
app.post('/api/logout', logout);
app.get('/api/me', (req, res) => res.json({ authed: isAuthed(req), name: state.settings.therapistName }));

// iPhone configuration profile: adds the app to the Home Screen.
app.get(['/app.mobileconfig', '/install.mobileconfig'], (req, res) => {
  const base = config.publicUrl || `${req.protocol}://${req.get('host')}`;
  const label = state.settings.therapistName;
  const body = buildMobileConfig({ url: base, label, iconPath: defaultIconPath(config.publicDir) });
  const filename = label.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '') || 'therapist';
  res.setHeader('Content-Type', 'application/x-apple-aspen-config');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.mobileconfig"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(body);
});

// QR code for the install page, so you can open it on your phone from a computer.
app.get('/install-qr.svg', async (req, res) => {
  const base = config.publicUrl || `${req.protocol}://${req.get('host')}`;
  const svg = await QRCode.toString(`${base}/install`, { type: 'svg', margin: 1, color: { dark: '#2b2233', light: '#ffffff' } });
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(svg);
});

// Web app manifest, named after whatever you call your therapist.
app.get('/manifest.webmanifest', (req, res) => {
  const name = state.settings.therapistName;
  res.setHeader('Content-Type', 'application/manifest+json');
  res.setHeader('Cache-Control', 'no-cache');
  res.json({
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
  });
});

app.use(
  express.static(config.publicDir, {
    extensions: ['html'],
    setHeaders(res, filePath) {
      res.setHeader('Cache-Control', 'no-cache'); // always revalidate; the service worker handles offline
      if (filePath.endsWith('.webmanifest')) res.setHeader('Content-Type', 'application/manifest+json');
    },
  }),
);

// ---------- Everything below needs the access code ----------

const api = express.Router();
api.use(requireAuth);

function checkinStatus() {
  return {
    nextAt: state.checkin.nextAt,
    lastSentAt: state.checkin.lastSentAt,
    paused: state.settings.checkins.enabled && state.checkin.unanswered >= 3,
  };
}

const PAGE = 120;

api.get('/state', (req, res) => {
  const recent = state.messages.slice(-PAGE);
  res.json({
    settings: state.settings,
    frequencies: Object.fromEntries(Object.entries(FREQUENCIES).map(([k, v]) => [k, v.label])),
    messages: recent.map(publicMessage),
    hasMore: state.messages.length > recent.length,
    memory: { text: state.memory.text, updatedAt: state.memory.updatedAt },
    push: { publicKey: vapidPublicKey, devices: state.pushSubscriptions.length },
    checkin: checkinStatus(),
    server: { demo: config.mockAI, hasApiKey: config.hasApiKey || config.mockAI },
  });
});

api.get('/messages', (req, res) => {
  const after = Number(req.query.after) || 0;
  const before = Number(req.query.before) || Infinity;
  const list = state.messages.filter((m) => m.createdAt > after && m.createdAt < before);
  const page = after ? list.slice(0, PAGE) : list.slice(-PAGE);
  res.json({ messages: page.map(publicMessage), hasMore: list.length > page.length });
});

api.put('/settings', (req, res) => {
  const before = state.settings;
  state.settings = applySettingsPatch(before, req.body);
  const a = before.checkins;
  const b = state.settings.checkins;
  const scheduleChanged =
    a.enabled !== b.enabled ||
    a.frequency !== b.frequency ||
    a.startHour !== b.startHour ||
    a.endHour !== b.endHour ||
    before.timezone !== state.settings.timezone;
  if (scheduleChanged) {
    if (b.enabled && !a.enabled) state.checkin.unanswered = 0;
    reschedule();
  }
  save();
  res.json({ settings: state.settings, checkin: checkinStatus() });
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadBytes, files: 1 } });

api.post('/upload', (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      return res.status(400).json({ error: tooBig ? 'That file is over 20 MB. Try a smaller one.' : 'Upload failed. Try again?' });
    }
    if (!req.file) return res.status(400).json({ error: 'No file received.' });
    try {
      const meta = await saveUpload(req.file);
      res.json({ attachment: { id: meta.id, name: meta.name, kind: meta.kind, mime: meta.mime, size: meta.size } });
    } catch (e) {
      if (!(e instanceof UploadError)) console.error('Upload failed:', e);
      res.status(400).json({ error: e instanceof UploadError ? e.message : 'Upload failed. Try again?' });
    }
  });
});

api.get('/attachments/:id', (req, res) => {
  const meta = state.attachments[req.params.id];
  if (!meta) return res.status(404).end();
  res.setHeader('Content-Type', meta.mime);
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.setHeader('Content-Security-Policy', 'sandbox');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(meta.name)}`);
  res.sendFile(attachmentPath(meta));
});

// Send messages and stream the reply back with server-sent events.
// Body: { items: [{ text, attachmentIds }] }. An empty list asks for a reply to what's already there (retry).
api.post('/chat', async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 10) : [];
  const clean = [];
  for (const it of items) {
    const text = typeof it?.text === 'string' ? it.text.trim().slice(0, 8000) : '';
    const ids = Array.isArray(it?.attachmentIds)
      ? it.attachmentIds.filter((id) => typeof id === 'string' && state.attachments[id]).slice(0, 10)
      : [];
    if (text || ids.length) clean.push({ text, ids });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  let open = true;
  res.on('close', () => (open = false));
  const send = (event, data) => {
    if (open) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const keepAlive = setInterval(() => open && res.write(': ping\n\n'), 15000);

  try {
    await withLock(async () => {
      const saved = clean.map((c) => addMessage({ role: 'user', text: c.text, attachments: c.ids }));
      if (saved.length) {
        noteUserActivity();
        send('saved', { messages: saved.map(publicMessage) });
      }
      if (state.messages.at(-1)?.role !== 'user') {
        send('done', { message: null });
        return;
      }
      send('typing', {});
      const { raw, reset } = await generateReply({ onDelta: (t) => send('delta', { t }) });
      const parsed = parseReply(raw);
      const reply = addMessage({ role: 'assistant', text: raw, mood: parsed.mood, crisis: parsed.crisis });
      send('done', { message: publicMessage(reply), reset: Boolean(reset) });
      // They closed the app before the reply finished: text them like a normal messaging app would.
      if (!open && state.settings.checkins.replyNotifications) notifyMessage(raw, 'reply').catch(() => {});
    });
  } catch (err) {
    console.error('Chat failed:', err);
    send('error', { error: friendlyMessage(err) });
  } finally {
    clearInterval(keepAlive);
    res.end();
  }
  maybeUpdateMemory().catch(() => {});
});

api.delete('/messages', async (req, res) => {
  await withLock(async () => {
    state.messages = [];
    state.historyStart = 0;
    await deleteAllAttachments();
    save();
  });
  res.json({ ok: true });
});

api.put('/memory', (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.slice(0, 6000) : '';
  state.memory.text = text.trim();
  state.memory.updatedAt = Date.now();
  save();
  res.json({ memory: { text: state.memory.text, updatedAt: state.memory.updatedAt } });
});

api.post('/memory/refresh', async (req, res) => {
  await maybeUpdateMemory({ force: true });
  res.json({ memory: { text: state.memory.text, updatedAt: state.memory.updatedAt } });
});

api.post('/push/subscribe', (req, res) => {
  try {
    addSubscription(req.body?.subscription, req.get('user-agent'));
    res.json({ ok: true, devices: state.pushSubscriptions.length });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

api.post('/push/unsubscribe', (req, res) => {
  if (typeof req.body?.endpoint === 'string') removeSubscription(req.body.endpoint);
  res.json({ ok: true, devices: state.pushSubscriptions.length });
});

api.post('/push/test', async (req, res) => {
  const delivered = await notifyAll({
    title: state.settings.therapistName,
    body: "Notifications are working! This is how I'll check in on you. 💛",
    tag: 'test',
  });
  res.json({ delivered });
});

api.post('/checkin', async (req, res) => {
  try {
    const msg = await sendCheckinNow({ manual: true });
    res.json({ message: publicMessage(msg), checkin: checkinStatus() });
  } catch (err) {
    console.error('Manual check-in failed:', err);
    res.status(500).json({ error: friendlyMessage(err) });
  }
});

api.get('/export', (req, res) => {
  const out = {
    exportedAt: new Date().toISOString(),
    therapist: state.settings.therapistName,
    memory: state.memory.text,
    messages: state.messages.map((m) => ({
      at: new Date(m.createdAt).toISOString(),
      from: m.role === 'user' ? 'me' : state.settings.therapistName,
      checkIn: m.kind === 'checkin' || undefined,
      text: m.role === 'user' ? m.text : plainText(m.text),
      files: (m.attachments || []).map((id) => state.attachments[id]?.name).filter(Boolean),
    })),
  };
  res.setHeader('Content-Disposition', 'attachment; filename="my-chats.json"');
  res.json(out);
});

app.use('/api', api);

// Unknown routes fall back to the app shell (but not for API or file-looking paths).
app.use((req, res) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/') && !path.extname(req.path)) {
    return res.sendFile(path.join(config.publicDir, 'index.html'));
  }
  res.status(404).json({ error: 'not_found' });
});

const server = app.listen(config.port, () => {
  console.log(`\n  ${state.settings.therapistName} is listening on http://localhost:${config.port}`);
  if (config.mockAI) console.log('  Demo mode: replies are canned (MOCK_AI=1). Set ANTHROPIC_API_KEY for the real thing.');
  else if (!config.hasApiKey) console.log('  Warning: ANTHROPIC_API_KEY is not set, so replies will fail until you add it.');
  else console.log(`  Model: ${config.model}`);
  console.log(`  iPhone install page: ${config.publicUrl || `http://localhost:${config.port}`}/install\n`);
});

startScheduler();

async function shutdown() {
  server.close();
  await flush();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
