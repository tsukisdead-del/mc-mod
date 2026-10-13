// Uploads for the Cloudflare version: photos are stored as-is; PDF and Word files are converted to
// text once (Workers AI toMarkdown, free for documents) so the model can read them. Document text is split
// into parts and indexed, so long documents (whole books) can be searched instead of read in full.
import { Buffer } from 'node:buffer';
import { classify, cleanName, checkText, UploadError } from '../server/file-types.js';
import { chunkText, charsPerToken } from '../server/doc-search.js';

// The free plan gives a Worker 128 MB of memory, and converting a file holds a few copies of it at once.
export const MAX_UPLOAD_MB = 20;
const MAX_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
// A D1 row holds at most 2,000,000 bytes; base64 adds a third.
const MAX_STORED_BYTES = 1_400_000;
// About 1,200 pages. Storing a document takes Worker CPU time in proportion to its length.
const MAX_DOC_CHARS = 3_000_000;

async function documentText(env, name, blob) {
  if (env.MOCK_AI === '1') return `(Demo mode: pretend this is the text of ${name}.)`;
  if (typeof env.AI?.toMarkdown !== 'function') {
    throw new UploadError("Reading documents isn't available on this server. Try sending a screenshot instead.");
  }
  let result;
  try {
    // Embedded pictures stay unconverted: describing them would spend the free AI allowance.
    result = await env.AI.toMarkdown(
      { name, blob },
      { conversionOptions: { pdf: { images: { convert: false }, metadata: false }, docx: { images: { convert: false } } } },
    );
  } catch (err) {
    console.error('toMarkdown failed:', err?.message || err);
    throw new UploadError("I couldn't open that file. If it's a scan or a photo of a page, send it as a photo instead.");
  }
  if (!result || result.format === 'error' || !result.data) {
    throw new UploadError("I couldn't read any text in that file. If it's a scan, send it as a photo instead.");
  }
  return result.data;
}

export async function handleUpload(request, env, store) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return { status: 400, body: { error: 'Upload failed. Try again?' } };
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') return { status: 400, body: { error: 'No file received.' } };
  if (file.size > MAX_BYTES) return { status: 400, body: { error: `That file is over ${MAX_UPLOAD_MB} MB. Try a smaller one.` } };
  try {
    const { kind, mime } = classify(file.name, file.type || '');
    if (kind === 'image' && file.size > MAX_STORED_BYTES) {
      return { status: 400, body: { error: 'That photo is too big. Try a screenshot of it instead.' } };
    }
    // Read the bytes only when they're needed, so a big document isn't held in memory twice.
    const keepOriginal = kind !== 'text' && file.size <= MAX_STORED_BYTES;
    const bytes = keepOriginal || kind === 'text' ? await file.arrayBuffer() : null;
    let doc = null;
    if (kind !== 'image') {
      const raw =
        kind === 'text'
          ? new TextDecoder().decode(bytes)
          : await documentText(env, file.name, file.type === mime ? file : new Blob([file], { type: mime }));
      const text = checkText(raw, MAX_DOC_CHARS);
      doc = { text, parts: chunkText(text), tokens: Math.ceil(text.length / charsPerToken(text)) };
    }
    const base64 = keepOriginal ? Buffer.from(bytes).toString('base64') : null;
    const meta = await store.saveAttachment({ name: cleanName(file.name), kind, mime, size: file.size }, base64, doc);
    return { status: 200, body: { attachment: { id: meta.id, name: meta.name, kind: meta.kind, mime: meta.mime, size: meta.size } } };
  } catch (err) {
    if (err instanceof UploadError) return { status: 400, body: { error: err.message } };
    console.error('Upload failed:', err?.message || err);
    return { status: 500, body: { error: 'Upload failed. Try again?' } };
  }
}
