// Canned replies for demo mode (MOCK_AI=1): try the app without an AI provider.
import { toneBand } from './prompts.js';
import { looksLikeCrisis } from './safety.js';

export function mockReplyText({ lastUserText = '', hasFiles = false, tone = 50 }) {
  const band = toneBand(tone).label;
  if (looksLikeCrisis(lastUserText)) {
    return "[[mood:concerned]] I'm really glad you told me. Are you safe right now?\n|||\nYou don't have to carry this alone. You can call or text **988** any time, or text HOME to 741741. If you're in danger right now, call 911. [[crisis]]\n|||\nI'm staying right here with you. What's happening tonight?";
  }
  if (hasFiles) {
    return "[[mood:curious]] (Demo mode) I got what you sent! With a real AI connected I'd look at it closely and tell you what I notice.\n|||\nWhat made you want to share it with me?";
  }
  if (tone > 64) return `[[mood:laughing]] okay okay I hear you 😂 (demo mode, tone ${tone}: ${band})\n|||\nreal talk though, what's actually going on?`;
  if (tone < 36) {
    return `[[mood:warm]] Thank you for sharing that with me. It sounds like there's a lot on your mind. (Demo mode, tone ${tone}: ${band})\n|||\nTake your time. What feels heaviest right now?`;
  }
  return `[[mood:thinking]] Hmm, I hear you. (Demo mode, tone ${tone}: ${band})\n|||\nWhat do you think is underneath that feeling?`;
}

const CHECKINS = [
  "[[mood:warm]] hey, just thinking about you. how's your day going?",
  '[[mood:happy]] checking in! did you drink some water today? 💧',
  "[[mood:proud]] random reminder that you're doing better than you think.\n|||\nhow are you feeling right now?",
];

export function mockCheckinText(random = Math.random) {
  return CHECKINS[Math.floor(random() * CHECKINS.length)];
}

export function mockMemoryText(current, pending) {
  const said = pending.filter((m) => m.role === 'user' && m.text).map((m) => `- They said: "${m.text.slice(0, 80)}"`);
  return [current, ...said.slice(-5)].filter(Boolean).join('\n').slice(-1500);
}

// Streams canned text in small pieces so the demo looks like typing.
export async function streamMock(raw, onDelta) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(500);
  for (let i = 0; i < raw.length; i += 3) {
    onDelta(raw.slice(i, i + 3));
    await sleep(18);
  }
}
