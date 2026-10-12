import fs from 'node:fs';
import path from 'node:path';
import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';
import { config } from './config.js';
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
  // Local open models can't read PDFs directly, so pull the text out now (and catch scans early).
  if (kind === 'pdf' && config.aiProvider === 'ollama') {
    let text = '';
    try {
      text = await pdfText(meta);
    } catch {
      // handled below
    }
    if (!text.trim()) {
      delete state.attachments[id];
      await fs.promises.rm(path.join(UPLOAD_DIR, fileName), { force: true });
      throw new UploadError("I couldn't find any text in that PDF (it might be a scan). Send it as a photo instead.");
    }
  }
  save();
  return meta;
}

// Text of a PDF, extracted once and cached next to the file.
export async function pdfText(meta) {
  if (meta.textFile) return fs.promises.readFile(path.join(UPLOAD_DIR, meta.textFile), 'utf8');
  const doc = await getDocumentProxy(new Uint8Array(await fs.promises.readFile(attachmentPath(meta))));
  const { text } = await extractText(doc, { mergePages: true });
  const clean = checkText(text);
  meta.textFile = meta.id + '.txt';
  await fs.promises.writeFile(path.join(UPLOAD_DIR, meta.textFile), clean, { mode: 0o600 });
  save();
  return clean;
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

// Parts for local open models (Ollama): photos as base64 (only those in `fresh`, the turn being answered,
// since re-sending old photos costs a lot of context), documents as text.
export async function openModelParts(ids, { fresh, vision, maxChars }) {
  const parts = [];
  for (const id of ids || []) {
    const meta = state.attachments[id];
    if (!meta) continue;
    try {
      if (meta.kind === 'image') {
        if (vision && fresh.has(id)) {
          parts.push({ type: 'image', mime: meta.mime, data: (await fs.promises.readFile(attachmentPath(meta))).toString('base64') });
        } else {
          parts.push({ type: 'text', text: `[They sent a photo: ${meta.name}${vision ? '' : " (you can't see photos, so ask them to describe it)"}]` });
        }
        continue;
      }
      const text = meta.kind === 'pdf' ? await pdfText(meta) : await fs.promises.readFile(path.join(UPLOAD_DIR, meta.textFile), 'utf8');
      const cut = text.length > maxChars;
      parts.push({
        type: 'text',
        text: `[Document they sent: "${meta.name}"]\n${cut ? text.slice(0, maxChars) : text}${cut ? '\n[Only the first part of this document fit; say so if it matters.]' : ''}`,
      });
    } catch (err) {
      console.error(`Attachment ${id} could not be read:`, err.message);
    }
  }
  return parts;
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
