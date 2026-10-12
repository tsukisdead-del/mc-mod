// Talking to Mochi: speech-to-text with the browser's Web Speech API (works in Safari on iPhone)
// and optional read-aloud with speechSynthesis. Voice preferences are per-device (localStorage).

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const synth = window.speechSynthesis;

const PREFS_KEY = 'mochi.voice';
const defaults = { readAloud: false, voiceURI: '', rate: 1, autoSend: true, handsFree: false };

export const voicePrefs = (() => {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') };
  } catch {
    return { ...defaults };
  }
})();

export function saveVoicePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(voicePrefs));
  } catch {
    // private mode: prefs just won't persist
  }
}

export const canListen = Boolean(SR);

// After the mic is used, iPhone keeps the audio session in "play and record" mode, which makes read-aloud
// quiet or play through the earpiece. Switch it back once listening ends (iOS 16.4+).
function micSession(on) {
  try {
    if (navigator.audioSession) navigator.audioSession.type = on ? 'play-and-record' : 'playback';
  } catch {
    // not supported
  }
}
export const canSpeak = Boolean(synth);

// ---------- Listening ----------

// Starts listening. Calls onText(text, isFinal) as words arrive and onEnd(finalText) when done.
// Stops by itself after a short silence. Returns { stop(), abort() }.
export function listen({ onText, onEnd, onError, silenceMs = 1800 }) {
  const rec = new SR();
  rec.lang = navigator.language || 'en-US';
  rec.interimResults = true;
  rec.continuous = true;
  rec.maxAlternatives = 1;

  let text = '';
  let silenceTimer = null;
  let ended = false;
  let aborted = false;

  const armSilence = () => {
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => rec.stop(), silenceMs);
  };

  rec.onresult = (event) => {
    // Rebuild the whole transcript each time; works the same in continuous and single-shot modes.
    let finalText = '';
    let interim = '';
    for (let i = 0; i < event.results.length; i++) {
      const r = event.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    text = (finalText + interim).replace(/\s+/g, ' ').trim();
    onText?.(text);
    armSilence();
  };
  rec.onerror = (event) => {
    if (event.error === 'no-speech' || event.error === 'aborted') return;
    onError?.(event.error);
  };
  rec.onend = () => {
    clearTimeout(silenceTimer);
    micSession(false);
    if (ended) return;
    ended = true;
    onEnd?.(aborted ? '' : text);
  };

  try {
    micSession(true);
    rec.start();
  } catch (err) {
    micSession(false);
    ended = true;
    onError?.(err.name === 'InvalidStateError' ? 'busy' : 'not-allowed');
    return { stop() {}, abort() {} };
  }
  // If nothing is said at all, give up after a while.
  silenceTimer = setTimeout(() => rec.stop(), 9000);

  return {
    stop: () => rec.stop(),
    abort: () => {
      aborted = true;
      rec.abort();
    },
  };
}

// ---------- Speaking ----------

let voices = [];
function loadVoices() {
  voices = synth ? synth.getVoices() : [];
  return voices;
}
if (synth) {
  loadVoices();
  synth.addEventListener?.('voiceschanged', loadVoices);
}

export function availableVoices() {
  const lang = (navigator.language || 'en').slice(0, 2);
  const list = loadVoices().filter((v) => v.lang?.toLowerCase().startsWith(lang));
  return (list.length ? list : voices).slice().sort((a, b) => scoreVoice(b) - scoreVoice(a) || a.name.localeCompare(b.name));
}

// Prefer natural-sounding voices.
function scoreVoice(v) {
  let s = 0;
  if (/premium|enhanced|natural|neural/i.test(v.name)) s += 3;
  if (/samantha|ava|zoe|serena|allison|karen|moira|google us english/i.test(v.name)) s += 2;
  if (v.localService) s += 1;
  if (v.lang === navigator.language) s += 1;
  return s;
}

function pickVoice() {
  const all = loadVoices();
  return all.find((v) => v.voiceURI === voicePrefs.voiceURI) || availableVoices()[0] || null;
}

// iOS only lets a page speak after a tap. Call this inside any tap handler.
let unlocked = false;
export function unlockSpeech() {
  if (!synth || unlocked) return;
  unlocked = true;
  const u = new SpeechSynthesisUtterance(' ');
  u.volume = 0;
  synth.speak(u);
}

function speakable(text) {
  return text
    .replace(/https?:\/\/\S+/g, 'the link')
    .replace(/[*_`#>|[\]]/g, '')
    .replace(/\p{Extended_Pictographic}|‍|️/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

let queue = 0;
const speakListeners = new Set();
export function onSpeaking(fn) {
  speakListeners.add(fn);
}
const emit = (on) => speakListeners.forEach((fn) => fn(on));

// Queue a piece of text. Returns a promise that resolves when it has been spoken.
export function speak(text) {
  const clean = speakable(text);
  if (!synth || !clean) return Promise.resolve();
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(clean);
    const v = pickVoice();
    if (v) {
      u.voice = v;
      u.lang = v.lang;
    }
    u.rate = Number(voicePrefs.rate) || 1;
    u.pitch = 1.05;
    queue++;
    u.onstart = () => emit(true);
    let done = false;
    // Some browsers occasionally never fire onend; don't let that freeze hands-free mode.
    const fallback = setTimeout(() => finish(), 4000 + (clean.length * 110) / u.rate);
    function finish() {
      if (done) return;
      done = true;
      clearTimeout(fallback);
      queue = Math.max(0, queue - 1);
      if (!queue) emit(false);
      resolve();
    }
    u.onend = finish;
    u.onerror = finish;
    synth.speak(u);
  });
}

export function isSpeaking() {
  return queue > 0;
}

export function stopSpeaking() {
  if (!synth) return;
  synth.cancel();
  queue = 0;
  emit(false);
}

// ---------- Recording (fallback when the browser has no speech recognition) ----------
// The free Cloudflare version can transcribe audio on the server. We record with MediaRecorder, stop after a
// pause, and convert to 16 kHz mono WAV in the browser (iPhone records AAC, which the server may not decode).

const AC = window.AudioContext || window.webkitAudioContext;
export const canRecord = Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder && AC && window.OfflineAudioContext);

function wavFromSamples(samples, rate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buffer);
  const text = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

async function toWav16k(blob, ctx) {
  const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  const rate = 16000;
  const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * rate)), rate);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return wavFromSamples(rendered.getChannelData(0), rate);
}

// Records until they pause (or stop() is called). onEnd(wavBlob | null). Returns { stop(), abort() }.
export function record({ onEnd, onError, silenceMs = 1600, maxMs = 60000, onStart }) {
  let stream;
  let recorder;
  let ctx;
  let raf;
  let timer;
  let heard = false;
  let quietSince = 0;
  let aborted = false;
  let done = false;
  const chunks = [];

  const stop = () => {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  };

  const finish = async () => {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    clearTimeout(timer);
    stream?.getTracks().forEach((t) => t.stop());
    micSession(false);
    try {
      if (aborted || !heard || !chunks.length) return onEnd(null);
      onEnd(await toWav16k(new Blob(chunks, { type: recorder.mimeType || 'audio/mp4' }), ctx));
    } catch {
      onError?.('decode');
    } finally {
      ctx?.close().catch(() => {});
    }
  };

  (async () => {
    try {
      // Create the audio context during the tap (iOS requires a user gesture), then ask for the mic.
      ctx = new AC();
      if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
      micSession(true);
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (err) {
      done = true;
      micSession(false);
      ctx?.close().catch(() => {});
      return onError?.(err?.name === 'NotAllowedError' ? 'not-allowed' : 'no-mic');
    }
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = finish;
    recorder.start(250);
    onStart?.();
    const samples = new Float32Array(analyser.fftSize);
    const started = performance.now();
    const loop = () => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const s of samples) sum += s * s;
      const loud = Math.sqrt(sum / samples.length) > 0.02;
      const now = performance.now();
      if (loud) {
        heard = true;
        quietSince = 0;
      } else if (heard) {
        quietSince ||= now;
        if (now - quietSince > silenceMs) return stop();
      } else if (now - started > 9000) {
        return stop(); // nothing said at all
      }
      raf = requestAnimationFrame(loop);
    };
    loop();
    timer = setTimeout(stop, maxMs);
  })();

  return {
    stop,
    abort: () => {
      aborted = true;
      stop();
      if (!recorder) finish();
    },
  };
}
