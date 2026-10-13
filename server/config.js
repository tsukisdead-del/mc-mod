import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load a local .env file when present (Node 20.12+). Hosting platforms set real env vars instead.
try {
  process.loadEnvFile();
} catch {
  // no .env file — that's fine
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const config = {
  root,
  publicDir: path.join(root, 'public'),
  port: Number(process.env.PORT) || 3000,
  dataDir: path.resolve(process.env.DATA_DIR || path.join(root, 'data')),
  accessCode: (process.env.ACCESS_CODE || '').trim(),
  // Optional: the public https URL of the app. Used in the iPhone profile. If unset, it's taken from the request.
  publicUrl: (
    process.env.PUBLIC_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '')
  )
    .trim()
    .replace(/\/+$/, ''),
  model: (process.env.CLAUDE_MODEL || 'claude-opus-5-5').trim(),
  chatEffort: (process.env.CHAT_EFFORT || 'medium').trim(),
  mockAI: process.env.MOCK_AI === '1',
  hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
  // Who does the thinking: Claude when an API key is set, otherwise Ollama on this computer (free).
  aiProvider:
    process.env.MOCK_AI === '1' ? 'mock' : process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? 'anthropic' : 'ollama',
  ollamaUrl: (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').trim().replace(/\/+$/, ''),
  ollamaModel: (process.env.OLLAMA_MODEL || 'gemma4').trim(),
  // Ollama's default context is small; the persona, notes and recent chat need more room.
  ollamaNumCtx: Number(process.env.OLLAMA_NUM_CTX) || 16384,
  ollamaVision: process.env.OLLAMA_VISION !== '0',
  vapidSubject: (process.env.VAPID_SUBJECT || '').trim(),
  vapidPublicKey: (process.env.VAPID_PUBLIC_KEY || '').trim(),
  vapidPrivateKey: (process.env.VAPID_PRIVATE_KEY || '').trim(),
  // Under 100 MB, the most a Cloudflare tunnel passes through.
  maxUploadBytes: 50 * 1024 * 1024,
};
