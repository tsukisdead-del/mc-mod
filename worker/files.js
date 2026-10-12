// Uploads for the Cloudflare version: photos are stored as-is; PDF and Word files are converted to
// text once (Workers AI toMarkdown, free for documents) so the model can read them.
import { Buffer } from 'node:buffer';
import { classify, cleanName, checkText, UploadError } from '../server/file-types.js';

const MAX_BYTES = 20 * 1024 * 1024;
// A D1 row holds at most 2,000,000 bytes; base64 adds a third.
const MAX_STORED_BYTES = 1_400_000;

async function documentText(env, name, bytes, mime) {
  if (env.MOCK_AI === '1') return `(Demo mode: pretend this is the text of ${name}.)`;
  if (typeof env.AI?.toMarkdown !== 'function') {
    throw new UploadError("Reading documents isn't available on this server. Try sending a screenshot instead.");
  }
  let result;
  try {
    // Embedded pictures stay unconverted: describing them would spend the free AI allowance.
    result = await env.AI.toMarkdown(
      { name, blob: new Blob([bytes], { type: mime }) },
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
  if (file.size > MAX_BYTES) return { status: 400, body: { error: 'That file is over 20 MB. Try a smaller one.' } };
  try {
    const { kind, mime } = classify(file.name, file.type || '');
    if (kind === 'image' && file.size > MAX_STORED_BYTES) {
      return { status: 400, body: { error: 'That photo is too big. Try a screenshot of it instead.' } };
    }
    const bytes = await file.arrayBuffer();
    let text = null;
    if (kind === 'pdf' || kind === 'docx') text = checkText(await documentText(env, file.name, bytes, mime));
    else if (kind === 'text') text = checkText(new TextDecoder().decode(bytes));
    // Keep the original when it fits (always for photos); otherwise the extracted text is what we have.
    const base64 = kind !== 'text' && bytes.byteLength <= MAX_STORED_BYTES ? Buffer.from(bytes).toString('base64') : null;
    const meta = await store.saveAttachment({ name: cleanName(file.name), kind, mime, size: file.size, text }, base64);
    return { status: 200, body: { attachment: { id: meta.id, name: meta.name, kind: meta.kind, mime: meta.mime, size: meta.size } } };
  } catch (err) {
    if (err instanceof UploadError) return { status: 400, body: { error: err.message } };
    console.error('Upload failed:', err?.message || err);
    return { status: 500, body: { error: 'Upload failed. Try again?' } };
  }
}
