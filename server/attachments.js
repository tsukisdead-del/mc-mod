import fs from 'node:fs';
import path from 'node:path';
import mammoth from 'mammoth';
import { state, save, newId, UPLOAD_DIR } from './store.js';

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const TEXT_EXTS = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.log', '.text', '.html', '.htm', '.xml', '.yaml', '.yml', '.rtf']);
const MAX_TEXT_CHARS = 400_000;

export class UploadError extends Error {}

function classify(name, mime) {
  const ext = path.extname(name || '').toLowerCase();
  if (IMAGE_TYPES.has(mime)) return { kind: 'image', mime, ext: '.' + mime.split('/')[1].replace('jpeg', 'jpg') };
  if (mime === 'image/heic' || mime === 'image/heif' || ext === '.heic' || ext === '.heif') {
    throw new UploadError('HEIC photos need converting first. Pick the photo from your library (iPhone converts it automatically) or take a screenshot of it.');
  }
  if (mime === 'application/pdf' || ext === '.pdf') return { kind: 'pdf', mime: 'application/pdf', ext: '.pdf' };
  if (ext === '.docx' || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return { kind: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: '.docx' };
  }
  if (TEXT_EXTS.has(ext) || mime.startsWith('text/') || mime === 'application/json') {
    return { kind: 'text', mime: 'text/plain', ext: ext || '.txt' };
  }
  if (ext === '.pages' || ext === '.doc' || ext === '.key' || ext === '.numbers') {
    throw new UploadError(`I can't open ${ext} files. Export it as a PDF (Share → Export → PDF) and send that instead.`);
  }
  throw new UploadError("I can read photos, PDFs, Word (.docx) files, and text files. That file type isn't supported yet.");
}

function cleanName(name) {
  return (
    String(name || 'file')
      .replace(/[\u0000-\u001f\u007f/\\]/g, '_')
      .slice(0, 120) || 'file'
  );
}

export async function saveUpload(file) {
  const { kind, mime, ext } = classify(file.originalname, file.mimetype || '');
  const id = newId();
  const fileName = id + ext;
  await fs.promises.writeFile(path.join(UPLOAD_DIR, fileName), file.buffer, { mode: 0o600 });

  const meta = { id, name: cleanName(file.originalname), kind, mime, size: file.size, file: fileName, createdAt: Date.now() };

  // Word and plain-text files are sent to Claude as text; extract it once now.
  if (kind === 'docx' || kind === 'text') {
    let text;
    if (kind === 'docx') {
      try {
        text = (await mammoth.extractRawText({ buffer: file.buffer })).value;
      } catch {
        throw new UploadError("That Word file couldn't be opened. Try exporting it as a PDF.");
      }
    } else {
      text = file.buffer.toString('utf8');
    }
    text = text.replace(/\u0000/g, '');
    if (!text.trim()) throw new UploadError('That file looks empty.');
    if (text.length > MAX_TEXT_CHARS) {
      throw new UploadError('That file is too long for me to read in one go. Try sending the part you want me to look at.');
    }
    meta.textFile = id + '.txt';
    await fs.promises.writeFile(path.join(UPLOAD_DIR, meta.textFile), text, { mode: 0o600 });
  }

  state.attachments[id] = meta;
  save();
  return meta;
}

export function attachmentPath(meta) {
  return path.join(UPLOAD_DIR, meta.file);
}

// Content blocks for the Claude Messages API.
export async function attachmentBlocks(ids) {
  const blocks = [];
  for (const id of ids || []) {
    const meta = state.attachments[id];
    if (!meta) continue;
    try {
      if (meta.kind === 'image') {
        const data = (await fs.promises.readFile(attachmentPath(meta))).toString('base64');
        blocks.push({ type: 'image', source: { type: 'base64', media_type: meta.mime, data } });
      } else if (meta.kind === 'pdf') {
        const data = (await fs.promises.readFile(attachmentPath(meta))).toString('base64');
        blocks.push({ type: 'document', title: meta.name, source: { type: 'base64', media_type: 'application/pdf', data } });
      } else {
        const data = await fs.promises.readFile(path.join(UPLOAD_DIR, meta.textFile), 'utf8');
        blocks.push({ type: 'document', title: meta.name, source: { type: 'text', media_type: 'text/plain', data } });
      }
    } catch (err) {
      console.error(`Attachment ${id} could not be read:`, err.message);
    }
  }
  return blocks;
}

// Short description used once a file is too old to resend in full.
export function attachmentPlaceholder(ids) {
  return (ids || [])
    .map((id) => state.attachments[id])
    .filter(Boolean)
    .map((m) => (m.kind === 'image' ? `[They sent a photo: ${m.name}]` : `[They sent a file: ${m.name}]`))
    .join(' ');
}

export async function deleteAllAttachments() {
  for (const meta of Object.values(state.attachments)) {
    for (const f of [meta.file, meta.textFile].filter(Boolean)) {
      await fs.promises.rm(path.join(UPLOAD_DIR, f), { force: true });
    }
  }
  state.attachments = {};
  save();
}
