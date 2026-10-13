import { api, streamChat, uploadFile, AuthError } from './api.js';
import { mountAvatar, face } from './avatar.js';
import { renderMarkdown } from './markdown.js';
import { parseReply, plainText } from './reply-format.js';
import * as voice from './voice.js';
import { fixName } from './transcript.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
}

const S = {
  settings: null,
  frequencies: {},
  messages: [],
  syncedAt: 0, // newest message time from the server's own list (see poll)
  hasMore: false,
  memory: { text: '' },
  push: {},
  checkin: {},
  server: {},
  pending: [], // files being attached to the next message
  queue: [], // messages waiting for the current reply to finish
  streaming: false,
  localUrls: new Map(), // attachment id -> local preview URL
};

const TONES = [
  { max: 15, label: 'Gentle & therapeutic', mood: 'warm', desc: 'Soft, patient and validating. Classic therapist energy with no jokes or sarcasm.' },
  { max: 35, label: 'Mostly gentle', mood: 'warm', desc: 'Warm and supportive with a little lightness. Validates first, then offers perspective.' },
  { max: 64, label: 'Balanced', mood: 'happy', desc: 'Real empathy plus honest perspective and some humor. Gently challenges unhelpful thinking.' },
  { max: 85, label: 'Real talk', mood: 'curious', desc: 'Casual, funny and direct. Banter, honest opinions, and calls out your patterns (kindly).' },
  { max: 100, label: 'No filter', mood: 'laughing', desc: "Best-friend energy. Blunt, roast-y, hypes you up, tells it straight. Still goes gentle when it really matters." },
];
const toneBand = (v) => TONES.find((t) => v <= t.max) || TONES[TONES.length - 1];

const STARTERS = ['I just need to vent', "I've been feeling anxious", 'Help me sort out my thoughts', 'Something happened today'];

// ---------- Small helpers ----------

let toastTimer;
function toast(text, ms = 3200) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function fmtStamp(ts) {
  const d = new Date(ts);
  const now = new Date();
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (days === 0) return `Today ${fmtTime(ts)}`;
  if (days === 1) return `Yesterday ${fmtTime(ts)}`;
  if (days < 7) return `${d.toLocaleDateString([], { weekday: 'long' })} ${fmtTime(ts)}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${fmtTime(ts)}`;
}

function fmtUpcoming(ts) {
  const d = new Date(ts);
  const today = new Date();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  if (d.toDateString() === today.toDateString()) return `today at ${fmtTime(ts)}`;
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow at ${fmtTime(ts)}`;
  return `${d.toLocaleDateString([], { weekday: 'long' })} at ${fmtTime(ts)}`;
}

const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const fmtHour = (h) => new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' });

const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const name = () => S.settings?.therapistName || 'Dr. Mochi';

// ---------- Screens ----------

// needsCode: the server has no access code yet (free Cloudflare version), so explain how to add one.
function showLogin(message = '', { needsCode = false } = {}) {
  $('#loginHint').textContent = needsCode
    ? "One last step: give me an access code so only you can read your chats. You'll type it once on each device."
    : 'Type your access code to unlock your chats.';
  $('#loginForm').hidden = needsCode;
  $('#setupSteps').hidden = !needsCode;
  $('#boot').hidden = true;
  $('#chat').hidden = true;
  $('#login').hidden = false;
  $('#loginError').textContent = message;
  face.mood('warm');
}

function showChat() {
  $('#boot').hidden = true;
  $('#login').hidden = true;
  $('#chat').hidden = false;
  if (S.messages.length) scrollToBottom(true);
}

function applyNames() {
  for (const n of $$('[data-tname]')) n.textContent = name();
  $('#input').placeholder = `Text ${name()}`;
  document.title = name();
}

let statusOverride = null;
function setStatus(text, live = false) {
  statusOverride = text ? { text, live } : null;
  const s = $('#status');
  s.textContent = text || (S.server.demo ? 'demo mode' : 'here for you');
  s.classList.toggle('live', Boolean(text && live));
}

// iOS keyboard: keep the chat exactly the size of the visible area.
function setupViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const update = () => {
    const stick = nearBottom();
    document.documentElement.style.setProperty('--app-h', `${vv.height}px`);
    if (vv.offsetTop) window.scrollTo(0, 0);
    if (stick) scrollToBottom(true);
  };
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  update();
}

// ---------- Scrolling ----------

const scroller = () => $('#scroller');
function nearBottom() {
  const s = scroller();
  return !s || s.scrollHeight - s.scrollTop - s.clientHeight < 140;
}
function scrollToBottom(force = false) {
  if (!force && !nearBottom()) return;
  requestAnimationFrame(() => {
    const s = scroller();
    s.scrollTop = s.scrollHeight;
  });
}
function stick(fn) {
  const was = nearBottom();
  fn();
  if (was) scrollToBottom(true);
}

// ---------- Thread rendering ----------

function bubble(text) {
  return el('div', 'bubble', renderMarkdown(text));
}

function attachmentSrc(a) {
  return S.localUrls.get(a.id) || `/api/attachments/${a.id}`;
}

function crisisCard() {
  return el(
    'div',
    'crisis',
    `<strong>You don't have to go through this alone. Free, 24/7 support:</strong>
     <div class="crisis-actions">
       <a href="tel:988">Call 988</a>
       <a href="sms:988">Text 988</a>
       <a class="secondary" href="sms:741741&amp;body=HOME">Text HOME to 741741</a>
       <a class="secondary" href="https://findahelpline.com" target="_blank" rel="noopener noreferrer">Outside the US</a>
     </div>`,
  );
}

function messageEl(m) {
  const g = el('div', `group ${m.role === 'user' ? 'user' : 'bot'}`);
  g.dataset.id = m.id;

  if (m.role === 'user') {
    const images = (m.attachments || []).filter((a) => a.kind === 'image');
    const docs = (m.attachments || []).filter((a) => a.kind !== 'image');
    if (images.length) {
      const wrap = el('div', `att-images${images.length > 1 ? ' multi' : ''}`);
      for (const a of images) {
        const img = new Image();
        img.alt = a.name;
        img.decoding = 'async';
        img.src = attachmentSrc(a);
        img.addEventListener('load', () => scrollToBottom());
        img.addEventListener('click', () => window.open(img.src, '_blank'));
        wrap.append(img);
      }
      g.append(wrap);
    }
    for (const a of docs) {
      const link = el('a', 'att-doc');
      link.href = `/api/attachments/${a.id}`;
      link.target = '_blank';
      link.rel = 'noopener';
      link.innerHTML = `<span class="doc-ic" aria-hidden="true">${a.kind === 'pdf' ? '📕' : '📄'}</span><span><span class="doc-name"></span><span class="doc-size">${fmtSize(a.size)}</span></span>`;
      $('.doc-name', link).textContent = a.name;
      g.append(link);
    }
    if (m.text) g.append(bubble(m.text));
    if (m.failed) {
      const meta = el('div', 'meta failed', 'Not delivered.');
      const retry = el('button', '', 'Try again');
      retry.addEventListener('click', () => resend(m));
      meta.append(retry);
      g.append(meta);
    }
  } else {
    if (m.kind === 'checkin') g.append(el('div', 'tag', 'checking in 💛'));
    for (const b of parseReply(m.text).bubbles) g.append(bubble(b));
    if (m.crisis) g.append(crisisCard());
  }
  return g;
}

function needsStamp(prev, m) {
  if (!prev) return true;
  if (new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString()) return true;
  return m.createdAt - prev.createdAt > 60 * 60 * 1000;
}

function emptyState() {
  const box = el('div', 'empty');
  const av = el('div', 'avatar');
  mountAvatar(av);
  box.append(av);
  box.append(el('h2', '', `Hey, I'm ${escapeText(name())} 👋`));
  box.append(
    el('p', '', 'This is your judgment-free space. Text me anything, tap the mic to talk out loud, or send a photo or document and I\'ll take a look.'),
  );
  const starters = el('div', 'starters');
  for (const s of STARTERS) {
    const b = el('button', '', escapeText(s));
    b.addEventListener('click', () => sendText(s));
    starters.append(b);
  }
  box.append(starters);
  return box;
}

function escapeText(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function renderThread({ keepScroll = false } = {}) {
  const thread = $('#thread');
  const s = scroller();
  const fromBottom = s.scrollHeight - s.scrollTop;
  thread.classList.add('no-anim');
  thread.textContent = '';
  if (!S.messages.length) thread.append(emptyState());
  let prev = null;
  for (const m of S.messages) {
    if (needsStamp(prev, m)) thread.append(el('div', 'stamp', fmtStamp(m.createdAt)));
    thread.append(messageEl(m));
    prev = m;
  }
  $('#loadEarlier').hidden = !S.hasMore;
  if (keepScroll) s.scrollTop = s.scrollHeight - fromBottom;
  else if (!S.messages.length) s.scrollTop = 0;
  else scrollToBottom(true);
  requestAnimationFrame(() => thread.classList.remove('no-anim'));
}

function addToThread(m) {
  const thread = $('#thread');
  stick(() => {
    $('.empty', thread)?.remove();
    const prev = [...S.messages].reverse().find((x) => x !== m);
    if (needsStamp(prev, m)) thread.append(el('div', 'stamp', fmtStamp(m.createdAt)));
    if (!S.messages.includes(m)) S.messages.push(m);
    thread.append(messageEl(m));
  });
}

function replaceInThread(oldId, m) {
  const node = $(`#thread .group[data-id="${CSS.escape(oldId)}"]`);
  const i = S.messages.findIndex((x) => x.id === oldId);
  if (i >= 0) S.messages[i] = m;
  if (node) {
    const fresh = messageEl(m);
    fresh.classList.add('settled');
    node.replaceWith(fresh);
  }
}

function lastSavedAt() {
  for (let i = S.messages.length - 1; i >= 0; i--) {
    if (!String(S.messages[i].id).startsWith('local-')) return S.messages[i].createdAt;
  }
  return 0;
}

// ---------- Live (streaming) reply ----------

let streamOpen = false;
let speaking = false;
function updateTalking() {
  face.talking(streamOpen || speaking);
}
voice.onSpeaking((on) => {
  speaking = on;
  updateTalking();
  if (!S.streaming) setStatus(on ? 'talking…' : null, on);
});

function startLive() {
  const thread = $('#thread');
  const g = el('div', 'group bot live');
  const typing = el('div', 'typing', '<i></i><i></i><i></i>');
  g.append(typing);
  stick(() => thread.append(g));
  let raw = '';
  let spoken = 0;
  let moodShown = false;

  const shouldSpeak = () => voice.voicePrefs.readAloud;

  function update() {
    const p = parseReply(raw, { partial: true });
    if (p.mood && !moodShown) {
      moodShown = true;
      face.mood(p.mood, 0);
    }
    stick(() => {
      const existing = $$('.bubble', g);
      p.bubbles.forEach((text, i) => {
        let b = existing[i];
        if (!b) {
          b = el('div', 'bubble');
          g.insertBefore(b, typing);
        }
        b.innerHTML = renderMarkdown(text);
        b.classList.toggle('streaming', p.open && i === p.bubbles.length - 1);
      });
      typing.hidden = p.open;
    });
    const finished = p.open ? p.bubbles.length - 1 : p.bubbles.length;
    while (spoken < finished) {
      if (shouldSpeak()) voice.speak(p.bubbles[spoken]);
      spoken++;
    }
    streamOpen = p.open;
    updateTalking();
    if (vm.open) {
      $('#voiceReply').innerHTML = renderMarkdown(p.bubbles.join('\n\n'));
      setVoiceStatus(`${name()} is typing…`);
    }
  }

  return {
    delta(t) {
      raw += t;
      update();
    },
    finish(message) {
      streamOpen = false;
      updateTalking();
      if (!message) {
        g.remove();
        return;
      }
      const final = parseReply(message.text);
      for (let i = spoken; i < final.bubbles.length; i++) if (shouldSpeak()) voice.speak(final.bubbles[i]);
      S.messages.push(message);
      const node = messageEl(message);
      node.classList.add('settled');
      stick(() => g.replaceWith(node));
      face.mood(final.mood || 'warm');
      if (vm.open) $('#voiceReply').innerHTML = renderMarkdown(final.bubbles.join('\n\n'));
    },
    fail(errorText, { retry = true } = {}) {
      streamOpen = false;
      updateTalking();
      g.remove();
      if (!errorText) return;
      const note = el('div', 'note');
      note.textContent = errorText + ' ';
      if (retry) {
        const b = el('button', '', 'Try again');
        b.addEventListener('click', () => {
          note.remove();
          pump({ retry: true });
        });
        note.append(b);
      }
      stick(() => $('#thread').append(note));
      face.mood('concerned', 6000);
    },
  };
}

// ---------- Sending ----------

function sendText(text, { attachments = [] } = {}) {
  voice.unlockSpeech();
  const local = {
    id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    role: 'user',
    kind: 'chat',
    text: text.trim(),
    attachments,
    createdAt: Date.now(),
  };
  addToThread(local);
  S.queue.push(local);
  pump();
}

function sendFromComposer() {
  const input = $('#input');
  if (S.pending.some((p) => p.status === 'uploading')) {
    toast('Still uploading, one sec…');
    return;
  }
  const ready = S.pending.filter((p) => p.status === 'ready');
  const text = input.value.trim();
  if (!text && !ready.length) return;
  for (const p of ready) if (p.previewUrl) S.localUrls.set(p.attachment.id, p.previewUrl);
  S.pending = [];
  renderPending();
  input.value = '';
  autoGrow();
  updateComposerButtons();
  sendText(text, { attachments: ready.map((p) => p.attachment) });
}

function resend(m) {
  const node = $(`#thread .group[data-id="${CSS.escape(m.id)}"]`);
  node?.remove();
  S.messages = S.messages.filter((x) => x !== m);
  sendText(m.text, { attachments: m.attachments });
}

async function pump({ retry = false } = {}) {
  if (S.streaming) return;
  const batch = S.queue.splice(0);
  if (!batch.length && !retry) return;
  S.streaming = true;
  setStatus('typing…', true);
  face.state('thinking');
  const live = startLive();
  let saved = false;
  let finished = false;
  try {
    await streamChat(
      batch.map((m) => ({ text: m.text, attachmentIds: (m.attachments || []).map((a) => a.id) })),
      {
        saved({ messages }) {
          saved = true;
          messages.forEach((m, i) => batch[i] && replaceInThread(batch[i].id, m));
        },
        delta({ t }) {
          face.state('idle');
          live.delta(t);
        },
        done({ message, catchUp }) {
          finished = true;
          live.finish(message);
          // The server waited for another reply to finish first; fetch that one too.
          if (catchUp) setTimeout(poll, 300);
        },
        error({ error }) {
          finished = true;
          live.fail(error);
        },
      },
    );
    if (!finished) throw new Error('dropped');
  } catch (err) {
    if (err instanceof AuthError) {
      S.streaming = false;
      showLogin(err.message);
      return;
    }
    if (saved || retry) {
      // The server has the message and keeps working; pick up the reply when it lands.
      live.fail('');
      setTimeout(poll, 2500);
      setTimeout(poll, 8000);
    } else {
      live.fail('');
      for (const m of batch) {
        m.failed = true;
        replaceInThread(m.id, m);
      }
      toast("Couldn't send. Check your connection and tap Try again.");
    }
  } finally {
    S.streaming = false;
    face.state('idle');
    setStatus(null);
  }
  if (S.queue.length) pump();
  else afterReplyInVoiceMode();
}

// Pick up messages that arrived another way: check-ins, replies finished while the app was closed.
// Asks for everything since the last time we synced (not just since the newest message on screen), so a reply
// that finished while another one was streaming isn't skipped.
async function poll() {
  if (S.streaming || document.hidden || $('#chat').hidden) return;
  try {
    const { messages } = await api(`/messages?after=${S.syncedAt}`);
    if (S.streaming) return; // a reply started meanwhile; the next poll gets everything
    const known = new Set(S.messages.map((x) => x.id));
    const fresh = messages.filter((m) => !known.has(m.id));
    if (messages.length) S.syncedAt = messages.at(-1).createdAt;
    if (!fresh.length) return;
    if (fresh[0].createdAt < lastSavedAt()) {
      // Something older than what's on screen: put everything back in order.
      const local = S.messages.filter((x) => String(x.id).startsWith('local-'));
      const saved = S.messages.filter((x) => !String(x.id).startsWith('local-'));
      S.messages = [...saved, ...fresh].sort((a, b) => a.createdAt - b.createdAt).concat(local);
      renderThread();
    } else {
      for (const m of fresh) addToThread(m);
    }
    const newest = [...fresh].reverse().find((m) => m.role === 'assistant');
    if (newest) face.mood(newest.mood || 'warm');
  } catch (err) {
    if (err instanceof AuthError) showLogin(err.message);
  }
}

// ---------- Attachments ----------

function loadImageElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ source: img, w: img.naturalWidth, h: img.naturalHeight, done: () => URL.revokeObjectURL(url) });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Couldn't read that photo."));
    };
    img.src = url;
  });
}

// Resize big photos (and convert iPhone HEIC) to a JPEG before upload.
async function shrinkImage(file) {
  // The free Cloudflare version asks for smaller photos: they're quicker for it to handle.
  const MAX = S.server.photoMaxSide || 1600;
  let loaded;
  try {
    loaded = await loadImageElement(file);
  } catch {
    const bmp = await createImageBitmap(file);
    loaded = { source: bmp, w: bmp.width, h: bmp.height, done: () => bmp.close?.() };
  }
  const scale = Math.min(1, MAX / Math.max(loaded.w, loaded.h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(loaded.w * scale));
  canvas.height = Math.max(1, Math.round(loaded.h * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(loaded.source, 0, 0, canvas.width, canvas.height);
  loaded.done();
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.86));
  if (!blob) throw new Error("Couldn't read that photo.");
  return { blob, name: `${(file.name || 'photo').replace(/\.[^.]+$/, '')}.jpg` };
}

async function addPending(file) {
  if (S.pending.length >= 6) {
    toast('You can attach up to 6 files at a time.');
    return;
  }
  const isImage = file.type.startsWith('image/') || /\.(heic|heif|jpe?g|png|gif|webp)$/i.test(file.name);
  const p = { key: Math.random().toString(36).slice(2), name: file.name, isImage, status: 'uploading', previewUrl: null, attachment: null };
  S.pending.push(p);
  renderPending();
  try {
    let blob = file;
    let fileName = file.name;
    if (isImage) {
      ({ blob, name: fileName } = await shrinkImage(file));
      p.previewUrl = URL.createObjectURL(blob);
      renderPending();
    } else if (file.size > (S.server.maxUploadMB || 20) * 1024 * 1024) {
      throw new Error(`That file is over ${S.server.maxUploadMB || 20} MB.`);
    }
    const form = new FormData();
    form.append('file', blob, fileName);
    const { attachment } = await uploadFile(form, (sent) => {
      p.progress = sent;
      showProgress(p);
    });
    p.attachment = attachment;
    p.status = 'ready';
  } catch (err) {
    if (err instanceof AuthError) return showLogin(err.message);
    toast(err.message || 'Upload failed.', 5000);
    S.pending = S.pending.filter((x) => x !== p);
  }
  renderPending();
}

// "45%" while a file is being sent, then "Reading…" while the server opens it (long documents take a moment).
function showProgress(p) {
  if (!p.statusEl) return;
  p.statusEl.textContent = p.status !== 'uploading' || p.progress === undefined ? '' : p.progress >= 1 ? 'Reading…' : `${Math.round(p.progress * 100)}%`;
}

function renderPending() {
  const box = $('#pendingFiles');
  box.textContent = '';
  box.hidden = !S.pending.length;
  for (const p of S.pending) {
    const item = el('div', `pending ${p.status}`);
    if (p.previewUrl) {
      const img = new Image();
      img.src = p.previewUrl;
      img.alt = p.name;
      item.append(img);
    } else {
      const d = el('div', 'p-doc', `<b>${p.isImage ? '🖼️' : '📄'}</b>`);
      d.append(document.createTextNode(p.name));
      item.append(d);
    }
    p.statusEl = el('span', 'p-status');
    showProgress(p);
    item.append(p.statusEl);
    const x = el('button', 'p-remove', '×');
    x.setAttribute('aria-label', `Remove ${p.name}`);
    x.addEventListener('click', () => {
      S.pending = S.pending.filter((y) => y !== p);
      renderPending();
    });
    item.append(x);
    box.append(item);
  }
  updateComposerButtons();
}

// ---------- Composer ----------

function autoGrow() {
  const input = $('#input');
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
}

function updateComposerButtons() {
  const hasContent = $('#input').value.trim() || S.pending.length;
  $('#sendBtn').hidden = !hasContent;
  $('#micBtn').hidden = Boolean(hasContent);
}

function wireComposer() {
  const input = $('#input');
  input.addEventListener('input', () => {
    autoGrow();
    updateComposerButtons();
  });
  const desktop = window.matchMedia('(pointer: fine)').matches;
  input.addEventListener('keydown', (e) => {
    if (desktop && e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendFromComposer();
    }
  });
  $('#sendBtn').addEventListener('click', () => {
    sendFromComposer();
    if (!desktop) input.blur();
  });
  // Keep the keyboard open when tapping send on iPhone.
  $('#sendBtn').addEventListener('pointerdown', (e) => e.preventDefault());

  $('#attachBtn').addEventListener('click', () => ($('#attachMenu').hidden = false));
  $('#attachMenu').addEventListener('click', (e) => {
    const pick = e.target.closest('[data-pick]')?.dataset.pick;
    if (!pick && e.target !== $('#attachMenu')) return;
    $('#attachMenu').hidden = true;
    if (pick === 'photo') $('#photoInput').click();
    if (pick === 'camera') $('#cameraInput').click();
    if (pick === 'doc') $('#docInput').click();
  });
  for (const id of ['#photoInput', '#cameraInput', '#docInput']) {
    $(id).addEventListener('change', (e) => {
      for (const f of e.target.files) addPending(f);
      e.target.value = '';
    });
  }

  $('#micBtn').addEventListener('click', openVoice);
  $('#whoBtn').addEventListener('click', openVoice);

  $('#loadEarlier').addEventListener('click', async () => {
    const first = S.messages.find((m) => !String(m.id).startsWith('local-'));
    if (!first) return;
    try {
      const { messages, hasMore } = await api(`/messages?before=${first.createdAt}`);
      S.messages = [...messages, ...S.messages];
      S.hasMore = hasMore;
      renderThread({ keepScroll: true });
    } catch (err) {
      toast(err.message);
    }
  });
}

// ---------- Voice mode ----------

const vm = { open: false, listening: false, transcribing: false, forceRecord: false, ctl: null };

function setVoiceStatus(text) {
  $('#voiceStatus').textContent = text;
}

function openVoice() {
  if (!hearingMode()) {
    toast("Talking isn't supported in this browser. Tap the 🎤 on your keyboard to dictate instead.", 5000);
    $('#input').focus();
    return;
  }
  voice.unlockSpeech();
  vm.open = true;
  $('#voice').hidden = false;
  $('#vmReadAloud').checked = voice.voicePrefs.readAloud;
  $('#vmHandsFree').checked = voice.voicePrefs.handsFree;
  $('#voiceReply').textContent = '';
  $('#voiceHeard').textContent = '';
  if (S.streaming) setVoiceStatus(`${name()} is typing…`);
  else startListening();
}

function closeVoice() {
  vm.open = false;
  vm.ctl?.abort();
  vm.listening = false;
  $('#voice').classList.remove('listening');
  $('#voice').hidden = true;
  voice.stopSpeaking();
  face.state('idle');
  setStatus(null);
}

// How we hear them: the browser's own speech recognition, or (free Cloudflare version) a recording that the
// server transcribes. Recognition can be blocked inside iPhone Home Screen apps, so we switch if it fails.
function hearingMode() {
  if (voice.canListen && !vm.forceRecord) return 'speech';
  if (S.server.transcribe && voice.canRecord) return 'record';
  return null;
}

async function transcribe(audio) {
  const res = await fetch('/api/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': audio.type || 'audio/wav' },
    body: audio,
    credentials: 'same-origin',
  });
  if (res.status === 401) throw new AuthError('Please unlock the app again.');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "I couldn't make that out. Try again?");
  return data.text || '';
}

function startListening() {
  if (vm.listening || vm.transcribing || !vm.open) return;
  if (S.streaming) {
    setVoiceStatus(`${name()} is typing…`);
    return;
  }
  const mode = hearingMode();
  if (!mode) return;
  voice.stopSpeaking();
  vm.listening = true;
  $('#voice').classList.add('listening');
  $('#voiceHeard').textContent = '';
  setVoiceStatus('Listening…');
  face.state('listening');
  setStatus('listening…', true);

  const stopped = () => {
    vm.listening = false;
    $('#voice').classList.remove('listening');
    face.state('idle');
    setStatus(null);
  };
  const heard = (said) => {
    if (!vm.open) return;
    const text = fixName(said || '', name());
    if (!text) {
      setVoiceStatus('Tap the mic and talk to me');
      return;
    }
    if (voice.voicePrefs.autoSend) {
      $('#voiceHeard').textContent = `“${text}”`;
      $('#voiceReply').textContent = '';
      setVoiceStatus(`${name()} is thinking…`);
      sendText(text);
    } else {
      const input = $('#input');
      input.value = [input.value.trim(), text].filter(Boolean).join(' ');
      autoGrow();
      updateComposerButtons();
      closeVoice();
      input.focus();
    }
  };
  let errored = false;
  const failed = (err) => {
    errored = true;
    stopped();
    const blocked = err === 'not-allowed' || err === 'service-not-allowed' || err === 'network';
    if (mode === 'speech' && blocked && S.server.transcribe && voice.canRecord) {
      vm.forceRecord = true;
      setVoiceStatus('Tap the mic again to talk');
      return;
    }
    setVoiceStatus(
      blocked || err === 'no-mic'
        ? 'Microphone access is off. On iPhone: Settings › Privacy & Security › Microphone (and Speech Recognition).'
        : err === 'decode'
          ? "I couldn't process that recording. Tap the mic and try again?"
          : 'Tap the mic and talk to me',
    );
  };

  if (mode === 'speech') {
    vm.ctl = voice.listen({
      onText: (text) => ($('#voiceHeard').textContent = `“${text}”`),
      onEnd: (text) => {
        stopped();
        // Speech recognition always ends after an error; keep the error's message on screen.
        if (!errored) heard(text);
      },
      onError: failed,
    });
    return;
  }
  vm.ctl = voice.record({
    onError: failed,
    onEnd: async (audio) => {
      stopped();
      if (!audio || !vm.open) return heard('');
      vm.transcribing = true;
      setVoiceStatus('Got it, writing that down…');
      try {
        heard(await transcribe(audio));
      } catch (err) {
        if (err instanceof AuthError) {
          closeVoice();
          showLogin(err.message);
        } else {
          setVoiceStatus(err.message);
        }
      } finally {
        vm.transcribing = false;
      }
    },
  });
}

async function afterReplyInVoiceMode() {
  if (!vm.open) return;
  // Let read-aloud finish before listening again.
  while (vm.open && voice.isSpeaking()) await new Promise((r) => setTimeout(r, 250));
  if (!vm.open) return;
  if (voice.voicePrefs.handsFree) startListening();
  else setVoiceStatus('Tap the mic to reply');
}

function wireVoice() {
  $('#voiceClose').addEventListener('click', closeVoice);
  $('#voiceMain').addEventListener('click', () => {
    voice.unlockSpeech();
    if (vm.listening) vm.ctl?.stop();
    else if (!vm.transcribing) startListening();
  });
  $('#vmReadAloud').addEventListener('change', (e) => {
    voice.voicePrefs.readAloud = e.target.checked;
    voice.saveVoicePrefs();
    if (!e.target.checked) voice.stopSpeaking();
    fillVoiceSettings();
  });
  $('#vmHandsFree').addEventListener('change', (e) => {
    voice.voicePrefs.handsFree = e.target.checked;
    voice.saveVoicePrefs();
    fillVoiceSettings();
  });
}

// ---------- Settings ----------

let saveTimer;
function saveSettings(patch) {
  if (patch) {
    for (const [k, v] of Object.entries(patch)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) S.settings[k] = { ...S.settings[k], ...v };
      else S.settings[k] = v;
    }
  }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const r = await api('/settings', { method: 'PUT', body: S.settings });
      S.settings = r.settings;
      S.checkin = r.checkin;
      applyNames();
      renderCheckinInfo();
    } catch (err) {
      if (err instanceof AuthError) return showLogin(err.message);
      toast(`Couldn't save settings: ${err.message}`);
    }
  }, 400);
}

function updateToneUI({ preview = false } = {}) {
  const v = Number($('#tone').value);
  const band = toneBand(v);
  $('#toneLabel').textContent = band.label;
  $('#toneValue').textContent = `${v}/100`;
  $('#toneDesc').textContent = band.desc;
  if (preview) face.mood(band.mood, 2500);
}

function renderCheckinInfo() {
  const c = S.settings.checkins;
  $('#ciOptions').hidden = !c.enabled;
  let text = '';
  if (c.enabled) {
    if (S.checkin.paused) text = "Paused because the last few check-ins didn't get a reply. They'll start again when you message.";
    else if (S.checkin.nextAt) text = `Next check-in: around ${fmtUpcoming(S.checkin.nextAt)}.`;
  }
  $('#ciNext').textContent = text;
}

function fillVoiceSettings() {
  const p = voice.voicePrefs;
  $('#readAloud').checked = p.readAloud;
  $('#autoSend').checked = p.autoSend;
  $('#handsFree').checked = p.handsFree;
  $('#voiceRate').value = p.rate;
  const sel = $('#voiceSelect');
  const voices = voice.availableVoices();
  sel.textContent = '';
  if (!voices.length) sel.append(new Option('Default voice', ''));
  for (const v of voices) sel.append(new Option(`${v.name} (${v.lang})`, v.voiceURI, false, v.voiceURI === p.voiceURI));
  $('#voiceSupport').textContent = hearingMode()
    ? 'Tap the mic next to the text box (or the face up top) to talk out loud. Replies show up as texts.'
    : "Talking out loud isn't supported in this browser. You can still use the dictation mic on your keyboard.";
}

function fillSettings() {
  const s = S.settings;
  $('#tone').value = s.tone;
  updateToneUI();
  $('#allowCursing').checked = s.allowCursing;
  $('#emojis').checked = s.emojis;
  $('#ciEnabled').checked = s.checkins.enabled;

  const freq = $('#ciFrequency');
  freq.textContent = '';
  for (const [k, label] of Object.entries(S.frequencies)) freq.append(new Option(label, k, false, k === s.checkins.frequency));
  for (const [id, value] of [
    ['#ciStart', s.checkins.startHour],
    ['#ciEnd', s.checkins.endHour],
  ]) {
    const sel = $(id);
    sel.textContent = '';
    for (let h = 0; h < 24; h++) sel.append(new Option(fmtHour(h), h, false, h === value));
  }
  for (const box of $$('#ciStyles input')) box.checked = Boolean(s.checkins.styles[box.value]);
  $('#replyNotifs').checked = s.checkins.replyNotifications;
  $('#therapistName').value = s.therapistName;
  $('#userName').value = s.userName;
  $('#memory').value = S.memory.text || '';
  renderCheckinInfo();
  fillVoiceSettings();
  renderFreeUsage();
}

// Free Cloudflare version: how much of today's free AI allowance is used.
function renderFreeUsage() {
  const card = $('#freeCard');
  if (S.server.provider === 'ollama') {
    card.hidden = false;
    $('#freeMeter').parentElement.hidden = true;
    $('#freeInfo').textContent = `Running free and privately on your own computer with Ollama (${S.server.model}). No daily limit, but your computer needs to be on and awake for replies and check-ins.`;
    return;
  }
  const u = S.server.usage;
  card.hidden = S.server.provider !== 'workers-ai' || !u;
  if (card.hidden) return;
  $('#freeMeter').parentElement.hidden = false;
  const pct = Math.min(100, Math.round((u.neurons / u.limit) * 100));
  const reset = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1));
  $('#freeMeter').style.width = `${pct}%`;
  $('#freeInfo').textContent =
    `Running on Cloudflare's free AI (${S.server.modelLabel || S.server.model}). ` +
    `Today you've used about ${pct}% of the free daily allowance (roughly ${Math.max(0, Math.floor((u.limit - u.neurons) / 35))} more texts). ` +
    `It resets at ${fmtTime(reset.getTime())}.`;
}

async function refreshFreeUsage() {
  if (S.server.provider !== 'workers-ai') return;
  try {
    S.server.usage = await api('/usage');
    renderFreeUsage();
  } catch {
    // not critical
  }
}

function wireSettings() {
  $('#settingsBtn').addEventListener('click', () => {
    fillSettings();
    refreshNotifUI();
    refreshFreeUsage();
    $('#settings').hidden = false;
  });
  $('#helpBtn').addEventListener('click', () => ($('#help').hidden = false));
  for (const b of $$('[data-close]')) b.addEventListener('click', () => (b.closest('.sheet').hidden = true));

  $('#tone').addEventListener('input', () => updateToneUI({ preview: true }));
  $('#tone').addEventListener('change', () => saveSettings({ tone: Number($('#tone').value) }));
  $('#allowCursing').addEventListener('change', (e) => saveSettings({ allowCursing: e.target.checked }));
  $('#emojis').addEventListener('change', (e) => saveSettings({ emojis: e.target.checked }));

  $('#ciEnabled').addEventListener('change', (e) => {
    saveSettings({ checkins: { enabled: e.target.checked } });
    renderCheckinInfo();
  });
  $('#ciFrequency').addEventListener('change', (e) => saveSettings({ checkins: { frequency: e.target.value } }));
  $('#ciStart').addEventListener('change', (e) => saveSettings({ checkins: { startHour: Number(e.target.value) } }));
  $('#ciEnd').addEventListener('change', (e) => saveSettings({ checkins: { endHour: Number(e.target.value) } }));
  $('#ciStyles').addEventListener('change', () => {
    const styles = {};
    for (const box of $$('#ciStyles input')) styles[box.value] = box.checked;
    if (!Object.values(styles).some(Boolean)) {
      toast('Pick at least one kind of check-in.');
      $('#ciStyles input[value="mood"]').checked = true;
      styles.mood = true;
    }
    saveSettings({ checkins: { styles } });
  });
  $('#replyNotifs').addEventListener('change', (e) => saveSettings({ checkins: { replyNotifications: e.target.checked } }));

  const saveName = (key) => (e) => saveSettings({ [key]: e.target.value.trim() });
  $('#therapistName').addEventListener('change', saveName('therapistName'));
  $('#userName').addEventListener('change', saveName('userName'));

  $('#notifBtn').addEventListener('click', togglePush);
  $('#testPush').addEventListener('click', async () => {
    try {
      const { delivered } = await api('/push/test', { method: 'POST' });
      toast(delivered ? `Sent! Check your notifications (${delivered} device${delivered > 1 ? 's' : ''}).` : 'No devices have notifications turned on yet.');
    } catch (err) {
      toast(err.message);
    }
  });
  $('#checkinNow').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Writing…';
    try {
      const { message, checkin } = await api('/checkin', { method: 'POST' });
      S.checkin = checkin;
      $('#settings').hidden = true;
      if (!S.messages.some((m) => m.id === message.id)) addToThread(message);
      face.mood(message.mood || 'warm');
      scrollToBottom(true);
    } catch (err) {
      toast(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Send me a check-in now';
    }
  });

  // Voice (stored on this device only)
  const vp = voice.voicePrefs;
  $('#readAloud').addEventListener('change', (e) => {
    vp.readAloud = e.target.checked;
    voice.saveVoicePrefs();
    if (vp.readAloud) voice.unlockSpeech();
    else voice.stopSpeaking();
  });
  $('#autoSend').addEventListener('change', (e) => {
    vp.autoSend = e.target.checked;
    voice.saveVoicePrefs();
  });
  $('#handsFree').addEventListener('change', (e) => {
    vp.handsFree = e.target.checked;
    voice.saveVoicePrefs();
  });
  $('#voiceSelect').addEventListener('change', (e) => {
    vp.voiceURI = e.target.value;
    voice.saveVoicePrefs();
  });
  $('#voiceRate').addEventListener('change', (e) => {
    vp.rate = Number(e.target.value);
    voice.saveVoicePrefs();
  });
  $('#voicePreview').addEventListener('click', () => {
    voice.unlockSpeech();
    voice.stopSpeaking();
    voice.speak(`Hi! I'm ${name()}. This is how I'll sound when I read my texts to you.`);
  });

  // Memory
  $('#memorySave').addEventListener('click', async () => {
    try {
      const { memory } = await api('/memory', { method: 'PUT', body: { text: $('#memory').value } });
      S.memory = memory;
      toast('Notes saved.');
    } catch (err) {
      toast(err.message);
    }
  });
  $('#memoryRefresh').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const { memory } = await api('/memory/refresh', { method: 'POST' });
      S.memory = memory;
      $('#memory').value = memory.text || '';
      toast('Notes updated.');
    } catch (err) {
      toast(err.message);
    } finally {
      btn.disabled = false;
    }
  });
  $('#memoryClear').addEventListener('click', async () => {
    if (!confirm(`Erase everything ${name()} remembers about you?`)) return;
    try {
      const { memory } = await api('/memory', { method: 'PUT', body: { text: '' } });
      S.memory = memory;
      $('#memory').value = '';
      toast('Memory erased.');
    } catch (err) {
      toast(err.message);
    }
  });

  // Data
  $('#clearChat').addEventListener('click', async () => {
    if (!confirm('Delete your whole chat history, including photos and files? This can’t be undone.')) return;
    try {
      await api('/messages', { method: 'DELETE' });
      S.messages = [];
      S.syncedAt = 0;
      S.hasMore = false;
      renderThread();
      $('#settings').hidden = true;
      toast('Chat history deleted.');
    } catch (err) {
      toast(err.message);
    }
  });
  $('#lockApp').addEventListener('click', async () => {
    // Notifications can quote your chats, so a locked device stops getting them too.
    const sub = await currentSubscription().catch(() => null);
    if (sub) {
      await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
      await sub.unsubscribe().catch(() => {});
    }
    await api('/logout', { method: 'POST' }).catch(() => {});
    $('#settings').hidden = true;
    showLogin();
  });
  $('#exportChats').addEventListener('click', (e) => exportChats(e.currentTarget));
}

// Builds the download page by page, so even years of chats never make one big, slow request.
async function exportChats(btn) {
  btn.disabled = true;
  try {
    const all = [];
    let before = 0;
    for (;;) {
      const { messages, hasMore } = await api(`/messages${before ? `?before=${before}` : ''}`);
      all.unshift(...messages);
      if (!hasMore || !messages.length) break;
      before = messages[0].createdAt;
    }
    const out = {
      exportedAt: new Date().toISOString(),
      therapist: name(),
      memory: S.memory?.text || '',
      messages: all.map((m) => ({
        at: new Date(m.createdAt).toISOString(),
        from: m.role === 'user' ? 'me' : name(),
        checkIn: m.kind === 'checkin' || undefined,
        text: m.role === 'user' ? m.text : plainText(m.text),
        files: (m.attachments || []).map((a) => a.name),
      })),
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }));
    const a = el('a');
    a.href = url;
    a.download = 'my-chats.json';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (err) {
    if (err instanceof AuthError) showLogin(err.message);
    else toast(`Couldn't download your chats: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

// ---------- Push notifications ----------

function base64ToBytes(b64) {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

function pushSupport() {
  const ok = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (ok) return 'ok';
  return isIOS() && !isStandalone() ? 'ios-browser' : 'unsupported';
}

async function currentSubscription() {
  if (pushSupport() !== 'ok') return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

// Was this device subscribed with the server's current push key? (It changes if the server's keys change.)
function sameKey(sub) {
  const key = sub.options?.applicationServerKey;
  if (!key || !S.push.publicKey) return true; // can't tell
  const a = new Uint8Array(key);
  const b = base64ToBytes(S.push.publicKey);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

async function subscribe(existing) {
  if (existing && sameKey(existing)) return existing;
  await existing?.unsubscribe();
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64ToBytes(S.push.publicKey) });
}

async function refreshNotifUI() {
  const btn = $('#notifBtn');
  const hint = $('#notifHint');
  btn.classList.remove('on');
  btn.disabled = false;
  const support = pushSupport();
  if (support === 'ios-browser') {
    btn.textContent = 'Install first';
    btn.disabled = true;
    hint.textContent = 'On iPhone, notifications only work in the Home Screen app (iOS 16.4 or newer). Install it from the iPhone install page below, open it from your Home Screen, then turn notifications on there.';
    return;
  }
  if (support === 'unsupported') {
    btn.textContent = 'Unavailable';
    btn.disabled = true;
    hint.textContent =
      isIOS() && isStandalone()
        ? "This Home Screen app can't get notifications. iPhone reliably allows them for apps added from Safari: open this site in Safari, tap Share → Add to Home Screen, and turn notifications on in that copy (iOS 16.4+). Check-ins still wait in the chat either way."
        : "This browser can't show notifications. Check-ins will still be waiting in the chat when you open the app.";
    return;
  }
  const sub = await currentSubscription().catch(() => null);
  if (Notification.permission === 'granted' && sub) {
    btn.textContent = 'On ✓';
    btn.classList.add('on');
    hint.textContent = 'Check-ins and replies will pop up like texts. Tap to turn them off on this device.';
  } else if (Notification.permission === 'denied') {
    btn.textContent = 'Blocked';
    hint.textContent = `Notifications are blocked. On iPhone: Settings › Notifications › ${name()} › Allow Notifications.`;
  } else {
    btn.textContent = 'Turn on';
    hint.textContent = 'So check-ins reach you even when the app is closed.';
  }
}

async function togglePush() {
  if (pushSupport() !== 'ok') return;
  const btn = $('#notifBtn');
  btn.disabled = true;
  try {
    const existing = await currentSubscription();
    if (existing && Notification.permission === 'granted') {
      await api('/push/unsubscribe', { method: 'POST', body: { endpoint: existing.endpoint } });
      await existing.unsubscribe();
      toast('Notifications off on this device.');
    } else {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        toast('Notifications were not allowed.');
      } else {
        const sub = await subscribe(existing);
        await api('/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
        toast(`Notifications on! ${name()} can text you now. 💛`);
      }
    }
  } catch (err) {
    toast(`Couldn't change notifications: ${err.message}`, 5000);
  }
  await refreshNotifUI();
  renderCheckinInfo();
}

// Re-register this device with the server in case its list was reset (or the access code changed).
async function syncPushSubscription() {
  try {
    if (pushSupport() !== 'ok' || Notification.permission !== 'granted') return;
    const existing = await currentSubscription();
    if (!existing) return;
    const sub = await subscribe(existing);
    await api('/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
  } catch {
    // not critical; the notifications button shows the real state
  }
}

// ---------- Startup ----------

async function loadState() {
  const data = await api('/state');
  Object.assign(S, {
    settings: data.settings,
    frequencies: data.frequencies,
    messages: data.messages,
    syncedAt: data.messages.at(-1)?.createdAt || 0,
    hasMore: data.hasMore,
    memory: data.memory,
    push: data.push,
    checkin: data.checkin,
    server: data.server,
  });
  applyNames();
  setStatus(statusOverride?.text, statusOverride?.live);
  $('#demoNote').hidden = !data.server.demo;
  renderThread();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (tz && tz !== S.settings.timezone) saveSettings({ timezone: tz });
  syncPushSubscription();
  const last = S.messages[S.messages.length - 1];
  if (last?.role === 'assistant' && Date.now() - last.createdAt < 10 * 60 * 1000) face.mood(last.mood || 'warm');
}

function wireLogin() {
  $('#setupDone').addEventListener('click', () => location.reload());
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = $('#codeInput').value;
    $('#loginError').textContent = '';
    try {
      await api('/login', { method: 'POST', body: { code } });
      $('#codeInput').value = '';
      await loadState();
      showChat();
      face.mood('happy');
    } catch (err) {
      $('#loginError').textContent = err.message;
      face.mood('concerned', 3000);
    }
  });
}

async function boot() {
  for (const node of $$('[data-avatar]')) mountAvatar(node);
  setupViewport();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type === 'push') poll();
    });
  }
  wireLogin();
  wireComposer();
  wireSettings();
  wireVoice();
  updateComposerButtons();

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      poll();
      navigator.clearAppBadge?.().catch(() => {});
    }
  });
  setInterval(poll, 25000);
  navigator.clearAppBadge?.().catch(() => {});

  try {
    const me = await api('/me');
    if (!me.authed) {
      for (const n of $$('[data-tname]')) n.textContent = me.name;
      return showLogin('', { needsCode: Boolean(me.needsCode) });
    }
    await loadState();
    showChat();
  } catch (err) {
    showLogin(err instanceof AuthError ? '' : "Can't reach the server right now. Check your connection and try again.");
  }
}

boot();
