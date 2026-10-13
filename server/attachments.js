import fs from 'node:fs';
import path from 'node:path';
import mammoth from 'mammoth';
import JSZip from 'jszip';
import { getDocumentProxy } from 'unpdf';
import { config } from './config.js';
import { state, save, newId, UPLOAD_DIR } from './store.js';
import { classify, cleanName, checkText, filePlaceholder, UploadError } from './file-types.js';
import {
  chunkText,
  charsPerToken,
  buildIndex,
  searchIndex,
  queryTerms,
  planDocuments,
  pickParts,
  overviewText,
  excerptText,
  pageLookup,
} from './doc-search.js';

export { UploadError };

const MAX_PDF_PAGES = 4000;
// Word files: mammoth is thorough but needs ~40x the document's XML in memory, so very big files use a
// simpler reader; past this size the file is turned away rather than risk running out of memory.
const MAMMOTH_MAX_XML = 10 * 1024 * 1024;
const MAX_DOCX_XML = 80 * 1024 * 1024;
// Claude reads a PDF's pages (pictures, tables, scans) itself while it's this small; bigger ones go as text.
const NATIVE_PDF = { bytes: 10 * 1024 * 1024, pages: 100, tokensPerPage: 2500 };

const textPath = (file) => path.join(UPLOAD_DIR, file);

// file: from multer's disk storage ({ originalname, mimetype, size, path }).
export async function saveUpload(file) {
  let kind;
  let mime;
  let ext;
  try {
    ({ kind, mime, ext } = classify(file.originalname, file.mimetype || ''));
  } catch (err) {
    await fs.promises.rm(file.path, { force: true });
    throw err;
  }
  const id = newId();
  const fileName = id + ext;
  await fs.promises.rename(file.path, textPath(fileName));
  const meta = { id, name: cleanName(file.originalname), kind, mime, size: file.size, file: fileName, createdAt: Date.now() };
  try {
    if (kind !== 'image') await extractText(meta);
  } catch (err) {
    await removeFiles(meta);
    throw err;
  }
  state.attachments[id] = meta;
  save();
  return meta;
}

// Reads a document's text once and keeps it next to the file (plus page offsets for PDFs).
async function extractText(meta) {
  const bytes = await fs.promises.readFile(attachmentPath(meta));
  let text;
  let pageStarts = null;
  if (meta.kind === 'pdf') {
    ({ text, pageStarts } = await pdfPages(bytes));
    meta.pages = pageStarts.length;
    if (!text.trim()) {
      // A scan (pictures of pages): Claude can still look at a small one; a local model can't read it at all.
      if (config.aiProvider === 'anthropic' && meta.size <= NATIVE_PDF.bytes && meta.pages <= NATIVE_PDF.pages) {
        meta.scanned = true;
        return;
      }
      throw new UploadError("I couldn't find any text in that PDF (it might be a scan). Send the pages as photos instead.");
    }
  } else if (meta.kind === 'docx') {
    text = await docxText(bytes);
  } else {
    text = bytes.toString('utf8');
  }
  text = checkText(text);
  meta.textFile = `${meta.id}.txt`;
  meta.chars = text.length;
  meta.tokens = Math.ceil(text.length / charsPerToken(text));
  await fs.promises.writeFile(textPath(meta.textFile), text, { mode: 0o600 });
  if (pageStarts) {
    meta.pagesFile = `${meta.id}.pages.json`;
    await fs.promises.writeFile(textPath(meta.pagesFile), JSON.stringify(pageStarts), { mode: 0o600 });
  }
}

// A PDF's text page by page (one at a time, so a long book doesn't hold every page in memory), with the
// character offset where each page starts.
async function pdfPages(bytes) {
  let doc;
  try {
    doc = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
  } catch (err) {
    if (err?.name === 'PasswordException') throw new UploadError('That PDF is password-protected. Save a copy without the password and send that.');
    throw new UploadError("I couldn't open that PDF. Try exporting it again, or send screenshots of the pages.");
  }
  try {
    if (doc.numPages > MAX_PDF_PAGES) {
      throw new UploadError(
        `That PDF has ${doc.numPages.toLocaleString('en-US')} pages, more than I can take. Try sending the part you want me to look at.`,
      );
    }
    let text = '';
    const pageStarts = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      pageStarts.push(text.length);
      for (const item of content.items) text += (item.str || '') + (item.hasEOL ? '\n' : '');
      text += '\n\n';
      page.cleanup();
      // Let other requests run while a long book is being read.
      if (i % 20 === 0) await new Promise((r) => setImmediate(r));
    }
    return { text, pageStarts };
  } finally {
    await doc.loadingTask?.destroy().catch(() => {});
  }
}

// Word file text. Big files skip mammoth (it can use gigabytes of memory) for a plain paragraph reader.
async function docxText(bytes) {
  let zip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new UploadError("That Word file couldn't be opened. Try exporting it as a PDF.");
  }
  const xml = zip.file('word/document.xml');
  if (!xml) throw new UploadError("That Word file couldn't be opened. Try exporting it as a PDF.");
  const size = xml._data?.uncompressedSize ?? 0;
  if (size > MAX_DOCX_XML) throw new UploadError('That Word file is too long for me. Try sending the part you want me to look at.');
  if (size && size <= MAMMOTH_MAX_XML) {
    try {
      return (await mammoth.extractRawText({ buffer: bytes })).value;
    } catch {
      // fall through to the simple reader
    }
  }
  return wordXmlText(await xml.async('string'));
}

// Paragraphs, tabs and line breaks from WordprocessingML; everything else (formatting) is dropped.
export function wordXmlText(xml) {
  const decode = (s) =>
    s
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  let out = '';
  for (const m of xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>|<\/w:p>/g)) {
    if (m[1] !== undefined) out += decode(m[1]);
    else if (m[0] === '<w:tab/>') out += '\t';
    else out += m[0] === '<w:br/>' ? '\n' : '\n\n';
  }
  return out;
}

export function attachmentPath(meta) {
  return path.join(UPLOAD_DIR, meta.file);
}

async function removeFiles(meta) {
  for (const f of [meta.file, meta.textFile, meta.pagesFile].filter(Boolean)) await fs.promises.rm(textPath(f), { force: true });
  indexes.delete(meta.id);
}

export async function deleteAllAttachments() {
  for (const meta of Object.values(state.attachments)) await removeFiles(meta);
  state.attachments = {};
  save();
}

// Short description used once a file is too old to resend in full.
export function attachmentPlaceholder(ids) {
  return filePlaceholder((ids || []).map((id) => state.attachments[id]));
}

// ---------- reading documents back ----------

// Documents saved by older versions: PDFs had no text yet, and nothing had a size.
async function ensureText(meta) {
  if (meta.textFile || meta.scanned) {
    if (meta.textFile && meta.chars === undefined) {
      const text = await fs.promises.readFile(textPath(meta.textFile), 'utf8');
      meta.chars = text.length;
      meta.tokens = Math.ceil(text.length / charsPerToken(text));
      save();
    }
    return;
  }
  await extractText(meta);
  save();
}

// Recently used documents stay split and indexed in memory (building an index takes ~0.3 s per book).
const indexes = new Map();
const KEEP_INDEXES = 4;

async function loadDocument(meta) {
  let doc = indexes.get(meta.id);
  if (doc) {
    indexes.delete(meta.id);
    indexes.set(meta.id, doc);
    return doc;
  }
  const text = await fs.promises.readFile(textPath(meta.textFile), 'utf8');
  const parts = chunkText(text);
  const pageStarts = meta.pagesFile ? JSON.parse(await fs.promises.readFile(textPath(meta.pagesFile), 'utf8').catch(() => '[]')) : null;
  doc = { text, parts, pageOf: pageLookup(parts, pageStarts), index: null };
  indexes.set(meta.id, doc);
  while (indexes.size > KEEP_INDEXES) indexes.delete(indexes.keys().next().value);
  return doc;
}

async function searchDocument(meta, terms, limit) {
  const doc = await loadDocument(meta);
  doc.index ??= buildIndex(doc.text, doc.parts);
  return searchIndex(doc.index, terms, limit).map((m) => ({ docId: meta.id, ...m }));
}

/**
 * Decides what every file in the conversation becomes for the model, and loads it.
 * turns: from buildTurns (files parts = recent attachments); messages: the verbatim history window;
 * fresh: attachment ids of the messages being answered; query: text to search long documents for ('' = none).
 * claude: Claude can see photos and small PDFs itself and takes base64 blocks; otherwise a local model.
 */
export async function prepareFiles({ turns, messages, fresh, query, budget, claude }) {
  const recentIds = turns.flatMap((t) => t.content.filter((p) => p.type === 'files').flatMap((p) => p.ids)).filter((id) => state.attachments[id]);
  const recent = new Set(recentIds);
  const docIds = [...new Set(messages.flatMap((m) => m.attachments || []))].filter(
    (id) => state.attachments[id] && state.attachments[id].kind !== 'image',
  );
  for (const id of docIds) {
    try {
      await ensureText(state.attachments[id]);
    } catch (err) {
      console.error(`Attachment ${id} could not be read:`, err.message);
    }
  }
  const native = new Set(
    claude
      ? docIds.filter((id) => {
          const m = state.attachments[id];
          if (m.kind !== 'pdf' || !recent.has(id) || m.size > NATIVE_PDF.bytes || (m.pages || 0) > NATIVE_PDF.pages) return false;
          return m.scanned || (m.pages || 1) * NATIVE_PDF.tokensPerPage <= budget.inlineFresh;
        })
      : [],
  );
  const docs = docIds
    .map((id) => state.attachments[id])
    .filter((m) => m.textFile && !native.has(m.id))
    .map((m) => ({
      id: m.id,
      meta: m,
      tokens: m.tokens,
      cpt: m.chars / Math.max(m.tokens, 1),
      chunks: Math.ceil(m.chars / 2000) || 1,
      fresh: fresh.has(m.id),
      recent: recent.has(m.id),
    }));
  const plan = planDocuments(docs, budget);
  const texts = {};
  const openings = {};
  for (const d of docs) {
    d.mode = plan.get(d.id);
    if (d.mode === 'search') continue;
    const loaded = await loadDocument(d.meta);
    d.chunks = loaded.parts.length;
    if (d.mode === 'inline') texts[d.id] = loaded.text;
    else openings[d.id] = loaded.text.slice(0, Math.floor(budget.overview * d.cpt));
  }

  // Matching parts of long and older documents, then samples for long ones that matched little.
  const searchable = docs.filter((d) => d.mode !== 'inline');
  const terms = query ? queryTerms(query) : [];
  const matches = [];
  if (terms.length) {
    for (const d of searchable) matches.push(...(await searchDocument(d.meta, terms, budget.maxParts)));
    matches.sort((a, b) => b.score - a.score);
  }
  for (const d of searchable) if (d.mode === 'search') d.chunks = (await loadDocument(d.meta)).parts.length;
  const picked = pickParts({ docs: searchable, matches, budget });
  const excerpts = [];
  for (const d of [...searchable].sort((a, b) => Number(b.fresh) - Number(a.fresh))) {
    const seqs = picked.get(d.id);
    if (!seqs?.length) continue;
    const loaded = await loadDocument(d.meta);
    excerpts.push(
      excerptText({
        name: d.meta.name,
        pages: d.meta.pages,
        chars: d.meta.chars,
        chunks: loaded.parts.length,
        pageOf: loaded.pageOf,
        older: d.mode === 'search',
        parts: seqs.map((seq) => ({ seq, text: loaded.text.slice(...loaded.parts[seq]) })),
      }),
    );
  }
  return { plan, texts, openings, native, excerpts, fresh, claude };
}

function docText(meta, f) {
  if (f.plan.get(meta.id) === 'long')
    return overviewText({ name: meta.name, pages: meta.pages, chars: meta.chars, opening: f.openings[meta.id] || '' });
  return `[Document they sent: "${meta.name}"]\n${f.texts[meta.id] || ''}`;
}

// Content blocks for the Claude Messages API.
export async function claudeParts(ids, f) {
  const blocks = [];
  for (const id of ids || []) {
    const meta = state.attachments[id];
    if (!meta) continue;
    try {
      if (meta.kind === 'image') {
        const data = (await fs.promises.readFile(attachmentPath(meta))).toString('base64');
        blocks.push({ type: 'image', source: { type: 'base64', media_type: meta.mime, data } });
      } else if (f.native.has(id)) {
        const data = (await fs.promises.readFile(attachmentPath(meta))).toString('base64');
        blocks.push({ type: 'document', title: meta.name, source: { type: 'base64', media_type: 'application/pdf', data } });
      } else if (f.plan.has(id)) {
        blocks.push({ type: 'text', text: docText(meta, f) });
      } else {
        blocks.push({ type: 'text', text: filePlaceholder([meta]) });
      }
    } catch (err) {
      console.error(`Attachment ${id} could not be read:`, err.message);
    }
  }
  return blocks;
}

// Parts for local open models (Ollama): photos as base64 (only those in `fresh`, the turn being answered,
// since re-sending old photos costs a lot of context), documents as text.
export async function localParts(ids, f, { vision }) {
  const parts = [];
  for (const id of ids || []) {
    const meta = state.attachments[id];
    if (!meta) continue;
    try {
      if (meta.kind === 'image') {
        if (vision && f.fresh.has(id)) {
          parts.push({ type: 'image', mime: meta.mime, data: (await fs.promises.readFile(attachmentPath(meta))).toString('base64') });
        } else {
          parts.push({
            type: 'text',
            text: `[They sent a photo: ${meta.name}${vision ? '' : " (you can't see photos, so ask them to describe it)"}]`,
          });
        }
      } else if (f.plan.has(id)) {
        parts.push({ type: 'text', text: docText(meta, f) });
      } else {
        parts.push({ type: 'text', text: filePlaceholder([meta]) });
      }
    } catch (err) {
      console.error(`Attachment ${id} could not be read:`, err.message);
    }
  }
  return parts;
}
