import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { config } from './config.js';
import { state, save, newId, UPLOAD_DIR, loadError } from './store.js';
import { classify, cleanName, checkText, filePlaceholder, UploadError, MAX_TEXT_CHARS } from './file-types.js';
import {
  chunkText,
  charsPerToken,
  buildIndex,
  searchIndex,
  queryTerms,
  planDocuments,
  pickParts,
  overviewNote,
  overviewText,
  excerptText,
  excerptDocument,
  pageLookup,
  partAt,
  refersToDocuments,
  structuralRefs,
  findChapter,
  relevant,
  canShowParts,
  neutralize,
  clip,
} from './doc-search.js';

export { UploadError };

const MAX_PDF_PAGES = 4000;
// Reading a file runs in its own thread with this much memory, and gives up after this long.
const EXTRACT_MEMORY_MB = 256;
const EXTRACT_TIMEOUT_MS = 3 * 60 * 1000;
// Claude reads a PDF's pages (pictures, tables, scans) itself while it's this small; bigger ones go as text.
// All the PDFs and photos in one request stay well under Claude's 32 MB request limit.
const NATIVE_PDF = { bytes: 10 * 1024 * 1024, pages: 100, tokensPerPage: 2500, totalBytes: 20 * 1024 * 1024 };

const filePath = (file) => path.join(UPLOAD_DIR, file);

let deletes = 0; // how many times all files were deleted (an upload that started before one is dropped)

// file: from multer's disk storage ({ originalname, mimetype, size, path }), a temporary file in UPLOAD_DIR.
// The text is read from the temporary file first; only a file that worked gets its final name.
export async function saveUpload(file) {
  const id = newId();
  const written = [];
  const deletesBefore = deletes;
  try {
    await fs.promises.chmod(file.path, 0o600);
    const { kind, mime, ext } = classify(file.originalname, file.mimetype || '');
    const meta = { id, name: cleanName(file.originalname), kind, mime, size: file.size, file: id + ext, createdAt: Date.now() };
    if (kind !== 'image') Object.assign(meta, await readDocument(file.path, kind, id, written));
    await fs.promises.rename(file.path, filePath(meta.file));
    written.push(filePath(meta.file));
    // The chat history was deleted while this file was on its way: it goes too.
    if (deletes !== deletesBefore) throw new UploadError('Your chat history was deleted, so that file was too.');
    state.attachments[id] = meta;
    save();
    return meta;
  } catch (err) {
    for (const p of [file.path, ...written]) await fs.promises.rm(p, { force: true });
    throw err;
  }
}

function extractInThread(file, kind) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./extract-worker.js', import.meta.url), {
      workerData: { file, kind, maxChars: MAX_TEXT_CHARS, maxPages: MAX_PDF_PAGES },
      resourceLimits: { maxOldGenerationSizeMb: EXTRACT_MEMORY_MB },
    });
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new UploadError('That file took too long to read. Try sending a smaller part of it.')), EXTRACT_TIMEOUT_MS);
    worker.once('message', (m) => {
      if (!m.error) return finish(resolve, m);
      if (!m.upload) console.error('Reading a file failed:', m.detail);
      finish(reject, new UploadError(m.error));
    });
    worker.once('error', (err) => {
      console.error('Reading a file failed:', err?.message || err);
      finish(reject, new UploadError(err?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'That file is too big for me to read. Try sending the part you want me to look at.' : "I couldn't read that file."));
    });
    worker.once('exit', () => finish(reject, new UploadError("I couldn't read that file.")));
  });
}

// Reads a document's text once and keeps it next to the file (plus page offsets for PDFs).
// Returns the fields to add to its attachment record; `written` collects the files created.
async function readDocument(source, kind, id, written) {
  const { text: raw, pageStarts } = await extractInThread(source, kind);
  const fields = {};
  if (pageStarts) fields.pages = pageStarts.length;
  if (kind === 'pdf' && !raw.trim()) {
    // A scan (pictures of pages): Claude can still look at a small one; a local model can't read it at all.
    const { size } = await fs.promises.stat(source);
    if (config.aiProvider === 'anthropic' && size <= NATIVE_PDF.bytes && fields.pages <= NATIVE_PDF.pages) return { ...fields, scanned: true };
    throw new UploadError("I couldn't find any text in that PDF (it might be a scan). Send the pages as photos instead.");
  }
  const text = checkText(raw);
  Object.assign(fields, {
    textFile: `${id}.txt`,
    chars: text.length,
    tokens: Math.ceil(text.length / charsPerToken(text)),
    chunks: chunkText(text).length,
  });
  written.push(filePath(fields.textFile));
  await fs.promises.writeFile(filePath(fields.textFile), text, { mode: 0o600 });
  if (pageStarts) {
    fields.pagesFile = `${id}.pages.json`;
    written.push(filePath(fields.pagesFile));
    await fs.promises.writeFile(filePath(fields.pagesFile), JSON.stringify(pageStarts), { mode: 0o600 });
  }
  return fields;
}

export function attachmentPath(meta) {
  return filePath(meta.file);
}

function filesOf(meta) {
  return [meta.file, meta.textFile, meta.pagesFile].filter(Boolean);
}

async function removeFiles(meta) {
  for (const f of filesOf(meta)) await fs.promises.rm(filePath(f), { force: true });
  forget(meta.id);
}

export async function deleteAllAttachments() {
  deletes++;
  for (const meta of Object.values(state.attachments)) await removeFiles(meta);
  state.attachments = {};
  save();
}

// At startup: remove files no attachment owns (an upload cut off by a restart or crash). Never when the saved
// state couldn't be read: then every file would look unused.
export function removeStrayFiles() {
  if (loadError) return;
  const known = new Set(Object.values(state.attachments).flatMap(filesOf));
  for (const f of fs.readdirSync(UPLOAD_DIR)) if (!known.has(f)) fs.rmSync(filePath(f), { force: true });
}

// Short description used once a file is too old to resend in full.
export function attachmentPlaceholder(ids) {
  return filePlaceholder((ids || []).map((id) => state.attachments[id]));
}

// ---------- reading documents back ----------

// Documents saved by older versions: PDFs had no text yet, and nothing had a size. A file that can't be read
// is marked, so it isn't retried on every reply.
async function ensureText(meta) {
  if (meta.unreadable || meta.scanned) return;
  try {
    if (!meta.textFile) {
      Object.assign(meta, await readDocument(attachmentPath(meta), meta.kind, meta.id, []));
    } else if (meta.chars === undefined || meta.chunks === undefined) {
      const text = await fs.promises.readFile(filePath(meta.textFile), 'utf8');
      Object.assign(meta, { chars: text.length, tokens: Math.ceil(text.length / charsPerToken(text)), chunks: chunkText(text).length });
    }
  } catch (err) {
    console.error(`Attachment ${meta.id} could not be read:`, err.message);
    meta.unreadable = true;
  }
  save();
}

// Recently used documents stay split and indexed in memory (building an index takes ~0.3 s per book), up to
// a total size; the least recently used go first.
const cache = new Map();
const KEEP_CHARS = 20_000_000;

function forget(id) {
  cache.delete(id);
}

async function loadDocument(meta) {
  let doc = cache.get(meta.id);
  if (doc) {
    cache.delete(meta.id);
    cache.set(meta.id, doc);
    return doc;
  }
  const text = await fs.promises.readFile(filePath(meta.textFile), 'utf8');
  const parts = chunkText(text);
  const pageStarts = meta.pagesFile ? JSON.parse(await fs.promises.readFile(filePath(meta.pagesFile), 'utf8').catch(() => '[]')) : null;
  doc = { text, parts, pageStarts, pageOf: pageLookup(parts, pageStarts), index: null };
  cache.set(meta.id, doc);
  let total = 0;
  for (const d of cache.values()) total += d.text.length;
  for (const [id, d] of cache) {
    if (total <= KEEP_CHARS || id === meta.id) break;
    cache.delete(id);
    total -= d.text.length;
  }
  return doc;
}

// The parts of a document they asked for by chapter or page: [{ seq, forced }].
function askedFor(doc, refs) {
  const out = [];
  for (const n of refs.chapters) {
    const at = findChapter(doc.text, n);
    if (at >= 0) out.push(partAt(doc.parts, at), partAt(doc.parts, at) + 1);
  }
  for (const p of refs.pages) {
    if (!doc.pageStarts?.[p - 1] && doc.pageStarts?.[p - 1] !== 0) continue;
    const first = partAt(doc.parts, doc.pageStarts[p - 1]);
    const last = partAt(doc.parts, Math.max((doc.pageStarts[p] ?? doc.text.length) - 1, doc.pageStarts[p - 1]));
    for (let s = first; s <= last; s++) out.push(s);
  }
  return out.filter((s) => s < doc.parts.length).map((seq) => ({ seq, forced: true }));
}

/**
 * Decides what every file in the conversation becomes for the model, and loads it.
 * turns: from buildTurns (files parts = recent attachments); messages: the verbatim history window;
 * fresh: attachment ids of the messages being answered; query: text to search long documents for ('' = none).
 * claude: Claude can see photos and small PDFs itself and takes document blocks; otherwise a local model.
 */
export async function prepareFiles({ turns, messages, fresh, query, budget, claude }) {
  const recentIds = turns.flatMap((t) => t.content.filter((p) => p.type === 'files').flatMap((p) => p.ids)).filter((id) => state.attachments[id]);
  const recent = new Set(recentIds);
  const docIds = [...new Set(messages.flatMap((m) => m.attachments || []))].filter((id) => state.attachments[id] && state.attachments[id].kind !== 'image');
  for (const id of docIds) await ensureText(state.attachments[id]);

  // Claude sees small PDFs as they are, newest first, while all of them (and the photos) stay under the
  // request size limit.
  const native = new Set();
  if (claude) {
    let bytes = recentIds.filter((id) => state.attachments[id].kind === 'image').reduce((n, id) => n + state.attachments[id].size, 0);
    for (const id of [...docIds].reverse()) {
      const m = state.attachments[id];
      if (m.kind !== 'pdf' || !recent.has(id) || !m.pages || m.size > NATIVE_PDF.bytes || m.pages > NATIVE_PDF.pages) continue;
      if (!m.scanned && m.pages * NATIVE_PDF.tokensPerPage > budget.inlineFresh) continue;
      if (bytes + m.size > NATIVE_PDF.totalBytes) continue;
      bytes += m.size;
      native.add(id);
    }
  }
  const docs = docIds
    .map((id) => state.attachments[id])
    .filter((m) => m.textFile && !m.unreadable && !native.has(m.id))
    .map((m) => ({
      id: m.id,
      meta: m,
      order: m.createdAt,
      tokens: m.tokens,
      cpt: m.chars / Math.max(m.tokens, 1),
      chunks: m.chunks,
      fresh: fresh.has(m.id),
      recent: recent.has(m.id),
    }));
  const plan = planDocuments(docs, budget);
  for (const d of docs) d.mode = plan.get(d.id);

  // Each document is read at most once per reply. One that can't be read becomes a placeholder.
  const loaded = new Map();
  const load = async (d) => {
    if (!loaded.has(d.id)) {
      try {
        loaded.set(d.id, await loadDocument(d.meta));
      } catch (err) {
        console.error(`Attachment ${d.id} could not be read:`, err.message);
        d.meta.unreadable = true;
        plan.delete(d.id);
        loaded.set(d.id, null);
      }
    }
    return loaded.get(d.id);
  };

  const texts = {};
  const openings = {};
  for (const d of docs.filter((x) => x.mode !== 'search')) {
    const doc = await load(d);
    if (!doc) continue;
    if (d.mode === 'inline') texts[d.id] = doc.text;
    else openings[d.id] = clip(doc.text, Math.floor(budget.overview * d.cpt));
  }

  // Matching parts of long documents, and of older ones when their message seems to be about one.
  const older = docs.filter((d) => d.mode === 'search');
  const askedAbout = Boolean(query) && refersToDocuments(query, older.map((d) => d.meta.name));
  const terms = query ? queryTerms(query) : [];
  const refs = structuralRefs(query);
  const searchable = docs.filter((d) => plan.has(d.id) && (d.mode === 'long' || (d.mode === 'search' && askedAbout)));
  const matches = [];
  for (const d of searchable) {
    if (!terms.length && !refs.chapters.length && !refs.pages.length) break;
    const doc = await load(d);
    if (!doc) continue;
    d.chunks = doc.parts.length;
    for (const m of askedFor(doc, refs)) matches.push({ docId: d.id, ...m });
    if (!terms.length) continue;
    doc.index ??= buildIndex(doc.text, doc.parts);
    // Scores from different documents aren't comparable, so each document's are scaled to its best match.
    const found = searchIndex(doc.index, terms, budget.maxParts);
    const best = found[0]?.score || 1;
    for (const m of found) matches.push({ docId: d.id, seq: m.seq, score: m.score / best, text: doc.text.slice(...doc.parts[m.seq]) });
  }
  matches.sort((a, b) => Number(Boolean(b.forced)) - Number(Boolean(a.forced)) || (b.score || 0) - (a.score || 0));
  const picked = pickParts({ docs: searchable, matches: relevant(matches, searchable, terms), budget });
  const excerpts = [];
  for (const d of [...searchable].sort((a, b) => Number(b.fresh) - Number(a.fresh))) {
    const seqs = picked.get(d.id);
    if (!seqs?.length) continue;
    const doc = await load(d);
    if (!doc) continue;
    excerpts.push({
      name: d.meta.name,
      pages: d.meta.pages,
      chars: d.meta.chars,
      chunks: doc.parts.length,
      pageOf: doc.pageOf,
      older: d.mode === 'search',
      parts: seqs.map((seq) => ({ seq, text: doc.text.slice(...doc.parts[seq]) })),
    });
  }
  const showParts = new Set(docs.filter((d) => canShowParts(budget, d.cpt)).map((d) => d.id));
  return { plan, texts, openings, native, excerpts, fresh, showParts };
}

function longNote(meta, f) {
  return { name: meta.name, pages: meta.pages, chars: meta.chars, opening: f.openings[meta.id] || '', searchable: f.showParts.has(meta.id) };
}

// Matching parts, added to their newest message: document blocks for Claude, text for a local model.
export function excerptBlocks(f, claude) {
  if (!f.excerpts.length) return [];
  if (claude) return f.excerpts.map((e) => excerptDocument(e));
  return [{ type: 'text', text: f.excerpts.map((e) => excerptText(e)).join('\n\n') }];
}

// Content blocks for the Claude Messages API. Documents go as document blocks: their material, kept apart
// from the conversation's own text.
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
      } else if (f.plan.get(id) === 'long') {
        const note = longNote(meta, f);
        blocks.push({ type: 'document', title: meta.name, context: overviewNote(note), source: { type: 'text', media_type: 'text/plain', data: note.opening || '(empty)' } });
      } else if (f.plan.get(id) === 'inline') {
        blocks.push({ type: 'document', title: meta.name, source: { type: 'text', media_type: 'text/plain', data: f.texts[id] || '(empty)' } });
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
          parts.push({ type: 'text', text: `[They sent a photo: ${meta.name}${vision ? '' : " (you can't see photos, so ask them to describe it)"}]` });
        }
      } else if (f.plan.get(id) === 'long') {
        parts.push({ type: 'text', text: overviewText(longNote(meta, f)) });
      } else if (f.plan.get(id) === 'inline') {
        parts.push({ type: 'text', text: `[Document they sent: "${meta.name}"]\n${neutralize(f.texts[id] || '')}` });
      } else {
        parts.push({ type: 'text', text: filePlaceholder([meta]) });
      }
    } catch (err) {
      console.error(`Attachment ${id} could not be read:`, err.message);
    }
  }
  return parts;
}
