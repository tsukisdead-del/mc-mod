// Which uploads the app accepts, and how each kind is handled. Shared by the Node server and the Worker.

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const TEXT_EXTS = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.log', '.text', '.html', '.htm', '.xml', '.yaml', '.yml', '.rtf']);
// Longest document text kept (about 4,000 pages). The Cloudflare version allows less (see worker/files.js).
export const MAX_TEXT_CHARS = 10_000_000;
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export class UploadError extends Error {}

function extname(name) {
  const m = String(name || '').toLowerCase().match(/\.[a-z0-9]+$/);
  return m ? m[0] : '';
}

export function classify(name, mime = '') {
  const ext = extname(name);
  if (IMAGE_TYPES.has(mime)) return { kind: 'image', mime, ext: '.' + mime.split('/')[1].replace('jpeg', 'jpg') };
  if (mime === 'image/heic' || mime === 'image/heif' || ext === '.heic' || ext === '.heif') {
    throw new UploadError('HEIC photos need converting first. Pick the photo from your library (iPhone converts it automatically) or take a screenshot of it.');
  }
  if (mime === 'application/pdf' || ext === '.pdf') return { kind: 'pdf', mime: 'application/pdf', ext: '.pdf' };
  if (ext === '.docx' || mime === DOCX_MIME) return { kind: 'docx', mime: DOCX_MIME, ext: '.docx' };
  if (TEXT_EXTS.has(ext) || mime.startsWith('text/') || mime === 'application/json') {
    return { kind: 'text', mime: 'text/plain', ext: ext || '.txt' };
  }
  if (ext === '.pages' || ext === '.doc' || ext === '.key' || ext === '.numbers') {
    throw new UploadError(`I can't open ${ext} files. Export it as a PDF (Share → Export → PDF) and send that instead.`);
  }
  throw new UploadError("I can read photos, PDFs, Word (.docx) files, and text files. That file type isn't supported yet.");
}

export function cleanName(name) {
  return (
    String(name || 'file')
      .replace(/[\u0000-\u001f\u007f/\\]/g, '_')
      .slice(0, 120) || 'file'
  );
}

// Validates extracted document text.
export function checkText(text, maxChars = MAX_TEXT_CHARS) {
  const clean = String(text || '').replace(/\u0000/g, '');
  if (!clean.trim()) throw new UploadError('That file looks empty.');
  if (clean.length > maxChars) {
    const pages = Math.round(maxChars / 2500 / 100) * 100;
    throw new UploadError(`That document is too long for me (I can take about ${pages.toLocaleString('en-US')} pages). Try sending the part you want me to look at.`);
  }
  return clean;
}

// Short description used once a file is too old to resend in full.
export function filePlaceholder(metas) {
  return metas
    .filter(Boolean)
    .map((m) => (m.kind === 'image' ? `[They sent a photo: ${m.name}]` : `[They sent a file: ${m.name}]`))
    .join(' ');
}
