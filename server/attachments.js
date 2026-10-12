import fs from 'node:fs';
import path from 'node:path';
import mammoth from 'mammoth';
import { state, save, newId, UPLOAD_DIR } from './store.js';
import { classify, cleanName, checkText, filePlaceholder, UploadError } from './file-types.js';

export { UploadError };

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
    text = checkText(text);
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
  return filePlaceholder((ids || []).map((id) => state.attachments[id]));
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
