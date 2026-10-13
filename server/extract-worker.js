// Reads a document's text in a separate thread with its own memory limit, so a huge or malicious file can only
// fail its own upload, never crash the server or freeze it while a long book is read (see attachments.js).
import fs from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import mammoth from 'mammoth';
import JSZip from 'jszip';
import { getDocumentProxy } from 'unpdf';
import { wordXmlText } from './word-text.js';

const { file, kind, maxChars, maxPages } = workerData;
// Word files: mammoth is thorough but needs ~40x the XML it reads in memory (the text, styles, notes...), so
// bigger files use a simpler reader, and past a size the file is turned away. Sizes are measured by unpacking,
// never taken from the zip's own records, which can lie.
const MAMMOTH_MAX_XML = 2 * 1024 * 1024;
const MAX_DOCX_XML = 40 * 1024 * 1024;
const MAX_DOCX_TOTAL = 120 * 1024 * 1024;

class UploadError extends Error {}
const tooLong = () => new UploadError('That document is too long for me. Try sending the part you want me to look at.');

// A PDF's text page by page, with the character offset where each page starts.
async function pdfPages(bytes) {
  let doc;
  try {
    doc = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
  } catch (err) {
    if (err?.name === 'PasswordException') throw new UploadError('That PDF is password-protected. Save a copy without the password and send that.');
    throw new UploadError("I couldn't open that PDF. Try exporting it again, or send screenshots of the pages.");
  }
  try {
    if (doc.numPages > maxPages) {
      throw new UploadError(`That PDF has ${doc.numPages.toLocaleString('en-US')} pages, more than I can take. Try sending the part you want me to look at.`);
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
      if (text.length > maxChars) throw tooLong();
    }
    return { text, pageStarts };
  } finally {
    await doc.loadingTask?.destroy().catch(() => {});
  }
}

// Inflates one zip entry, stopping as soon as it grows past `cap` bytes (whatever size the file claims).
function inflate(entry, cap) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const stream = entry.internalStream('uint8array');
    stream
      .on('data', (chunk) => {
        size += chunk.length;
        if (size > cap) {
          stream.pause();
          reject(tooLong());
          return;
        }
        chunks.push(chunk);
      })
      .on('error', reject)
      .on('end', () => resolve(Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)))))
      .resume();
  });
}

// The unpacked size of the XML parts in a Word file (what mammoth reads), or null once it passes `cap`.
async function xmlSize(zip, cap) {
  let total = 0;
  for (const f of Object.values(zip.files)) {
    if (f.dir || !/\.(xml|rels)$/i.test(f.name)) continue;
    try {
      total += (await inflate(f, cap - total)).length;
    } catch {
      return null;
    }
  }
  return total;
}

async function docxText(bytes) {
  let zip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new UploadError("That Word file couldn't be opened. Try exporting it as a PDF.");
  }
  const entry = zip.file('word/document.xml');
  if (!entry) throw new UploadError("That Word file couldn't be opened. Try exporting it as a PDF.");
  const declared = Object.values(zip.files).reduce((sum, f) => sum + (f._data?.uncompressedSize || 0), 0);
  if (declared > MAX_DOCX_TOTAL) throw tooLong();
  const xml = await inflate(entry, MAX_DOCX_XML);
  if (xml.length <= MAMMOTH_MAX_XML && (await xmlSize(zip, MAMMOTH_MAX_XML)) !== null) {
    try {
      return (await mammoth.extractRawText({ buffer: bytes })).value;
    } catch {
      // fall through to the simple reader
    }
  }
  return wordXmlText(xml.toString('utf8'));
}

try {
  const bytes = fs.readFileSync(file);
  const result = kind === 'pdf' ? await pdfPages(bytes) : { text: kind === 'docx' ? await docxText(bytes) : bytes.toString('utf8'), pageStarts: null };
  if (result.text.length > maxChars) throw tooLong();
  parentPort.postMessage(result);
} catch (err) {
  parentPort.postMessage({ error: err instanceof UploadError ? err.message : "I couldn't read that file. Try exporting it again.", upload: err instanceof UploadError, detail: String(err?.message || err) });
}

