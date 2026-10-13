// Long documents: split them into parts, find the parts that match what they said, and decide how much of each
// document the model sees. Pure functions (no Node or Worker APIs), shared by the Node server, the Cloudflare
// Worker and the tests.

// About 500 tokens of English per part: small enough to send several, big enough to keep a passage together.
export const CHUNK_CHARS = 2000;

// How much document text each kind of model gets per reply, in estimated tokens.
// - inlineFresh/inlineOlder: a document this size or smaller is sent whole (shared between the documents of that
//   kind); a bigger one is "long": its opening goes with the message it came with, and matching parts are added
//   to their newest message.
// - excerpts: room for those matching parts across all long documents. maxParts caps how many.
// - overview: the opening shown for a long document.
export const DOC_BUDGETS = {
  // Free Workers AI: every token spends the daily allowance.
  free: { inlineFresh: 11000, inlineOlder: 3500, excerpts: 4500, overview: 450, maxParts: 8 },
  // Claude: a 1M-token window, but each reply is billed, so whole documents only up to a point.
  claude: { inlineFresh: 100000, inlineOlder: 100000, excerpts: 20000, overview: 1500, maxParts: 30 },
  // Ollama with a 16k-token window (scaled for other window sizes with scaleBudget).
  local: { inlineFresh: 4000, inlineOlder: 1200, excerpts: 2600, overview: 350, maxParts: 6 },
};

export function scaleBudget(budget, factor) {
  const out = { ...budget };
  for (const k of ['inlineFresh', 'inlineOlder', 'excerpts', 'overview']) out[k] = Math.round(budget[k] * factor);
  return out;
}

// ---------- splitting ----------

// Splits text into consecutive [start, end) parts of about `size` characters, cutting at a paragraph break,
// else a sentence end, else a line break or space. The parts cover the text exactly (joined, they are the text).
// Uses only lastIndexOf, which stays fast enough for the Worker's CPU limit even on a book.
export function chunkText(text, size = CHUNK_CHARS) {
  const parts = [];
  const n = text.length;
  let start = 0;
  while (start < n) {
    let end = Math.min(start + size, n);
    if (end < n) {
      const min = start + Math.floor(size * 0.6);
      const cut = (s) => {
        const i = text.lastIndexOf(s, end - s.length);
        return i >= min ? i + s.length : -1;
      };
      let at = cut('\n\n');
      if (at < 0) at = Math.max(cut('. '), cut('? '), cut('! '), cut('.\n'), cut('。'), cut('！'), cut('？'));
      if (at < 0) at = cut('\n');
      if (at < 0) at = cut(' ');
      if (at > 0) end = at;
    }
    parts.push([start, end]);
    start = end;
  }
  return parts;
}

// ---------- words ----------

const STOPWORDS = new Set(
  (
    'a about above after again against all am an and any are as at be because been before being below between both but by can ' +
    'could did do does doing down during each few for from further had has have having he her here hers herself him himself his ' +
    'how i if in into is it its itself just me more most my myself no nor not now of off on once only or other our ours ourselves ' +
    'out over own same she should so some such than that the their theirs them themselves then there these they this those through ' +
    'to too under until up very was we were what when where which while who whom why will with would you your yours yourself ' +
    'yourselves tell said say says let get got also like know think want really dont im ive youre thats whats cant didnt doesnt ' +
    'isnt wasnt wont please thanks thank okay ok yeah yes hey hi hello um uh mean maybe something anything thing things one ' +
    'document doc file pdf book read part page pages chapter section'
  ).split(/\s+/),
);
// Scripts written without spaces between words: use character pairs as "words".
const NO_SPACES =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu;

function fold(w) {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

// Lowercased, accent-free search words, with common words dropped.
export function tokenize(text) {
  const out = [];
  const norm = String(text || '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();
  for (const m of norm.matchAll(WORD)) {
    const w = m[0].replace(/['’].*$/, '');
    if (NO_SPACES.test(w)) {
      const chars = [...w];
      if (chars.length === 1) out.push(w);
      for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i] + chars[i + 1]);
      continue;
    }
    if (w.length < 2 || STOPWORDS.has(w)) continue;
    out.push(fold(w));
  }
  return out;
}

// The words to search for: distinct, longest (most specific) first, at most `max`.
export function queryTerms(text, max = 12) {
  return [...new Set(tokenize(text))].sort((a, b) => b.length - a.length).slice(0, max);
}

// A D1 full-text (FTS5) query: each word quoted, joined with OR. Raw text could be a syntax error.
export function ftsQuery(terms) {
  return terms
    .map((t) => t.replace(/"/g, ''))
    .filter(Boolean)
    .map((t) => `"${t}"`)
    .join(' OR ');
}

// ---------- token estimates ----------

// Rough token count: English runs about 3.5 characters per token; other scripts take more tokens per character.
export function estimateTokens(text) {
  const s = String(text || '');
  let ascii = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) < 128) ascii++;
  return Math.ceil(ascii / 3.5 + (s.length - ascii) / 1.6);
}

// Characters per token for a document, from a sample of it.
export function charsPerToken(sample) {
  const s = String(sample || '').slice(0, 20000);
  return s.length ? Math.max(1.2, s.length / Math.max(estimateTokens(s), 1)) : 3.5;
}

// ---------- in-memory search (Node) ----------

// BM25 over a document's parts. The Worker uses D1's built-in full-text search instead.
export function buildIndex(text, parts) {
  const postings = new Map(); // word -> [part, count, part, count, ...]
  const lengths = new Uint32Array(parts.length);
  let total = 0;
  parts.forEach(([start, end], i) => {
    const words = tokenize(text.slice(start, end));
    lengths[i] = words.length;
    total += words.length;
    const counts = new Map();
    for (const w of words) counts.set(w, (counts.get(w) || 0) + 1);
    for (const [w, c] of counts) {
      let list = postings.get(w);
      if (!list) postings.set(w, (list = []));
      list.push(i, c);
    }
  });
  return { postings, lengths, avgLength: total / Math.max(parts.length, 1), count: parts.length };
}

// Best-matching parts, best first: [{ seq, score }].
export function searchIndex(index, terms, limit = 10) {
  const scores = new Map();
  for (const t of new Set(terms)) {
    const list = index.postings.get(t);
    if (!list) continue;
    const df = list.length / 2;
    const idf = Math.log(1 + (index.count - df + 0.5) / (df + 0.5));
    for (let j = 0; j < list.length; j += 2) {
      const i = list[j];
      const f = list[j + 1];
      const s = (idf * f * 2.2) / (f + 1.2 * (0.25 + (0.75 * index.lengths[i]) / index.avgLength));
      scores.set(i, (scores.get(i) || 0) + s);
    }
  }
  return [...scores]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([seq, score]) => ({ seq, score }));
}

// ---------- deciding what the model sees ----------

/**
 * docs: [{ id, tokens, fresh, recent }] (fresh = sent with the messages being answered; recent = still within
 * the last few messages). Returns id -> 'inline' (send it whole), 'long' (opening + matching parts) or 'search'
 * (older: matching parts only).
 */
export function planDocuments(docs, budget) {
  const fresh = docs.filter((d) => d.fresh);
  const older = docs.filter((d) => !d.fresh && d.recent);
  const freshShare = budget.inlineFresh / Math.max(fresh.length, 1);
  const olderShare = budget.inlineOlder / Math.max(older.length, 1);
  const plan = new Map();
  for (const d of docs) {
    if (d.fresh) plan.set(d.id, d.tokens <= freshShare ? 'inline' : 'long');
    else if (d.recent) plan.set(d.id, d.tokens <= olderShare ? 'inline' : 'long');
    else plan.set(d.id, 'search');
  }
  return plan;
}

/**
 * Which parts to show for the long documents. matches: [{ docId, seq, score }] best first, across documents.
 * docs: [{ id, chunks, mode, fresh, cpt }] (cpt: characters per token). Takes the best matches until the
 * budget is used; a long document they just sent that matched little also gets evenly spaced samples (so
 * "what's this about?" still works). Returns docId -> sorted seq list.
 */
export function pickParts({ docs, matches, budget, chunkChars = CHUNK_CHARS }) {
  const byId = new Map(docs.map((d) => [d.id, d]));
  const picked = new Map(docs.map((d) => [d.id, new Set()]));
  let left = budget.excerpts;
  let parts = 0;
  const cost = (d) => chunkChars / (d.cpt || 3.5);
  const take = (d, seq) => {
    const set = picked.get(d.id);
    if (set.has(seq) || seq < 0 || seq >= d.chunks || parts >= budget.maxParts || cost(d) > left) return false;
    set.add(seq);
    left -= cost(d);
    parts++;
    return true;
  };
  for (const m of matches) {
    const d = byId.get(m.docId);
    if (d) take(d, m.seq);
  }
  // Only for a long document they just sent: older ones that don't match what they said aren't the topic.
  for (const d of docs) {
    if (d.mode !== 'long' || !d.fresh) continue;
    const want = 4;
    const have = picked.get(d.id).size;
    if (have >= 2) continue;
    // Evenly spaced through the document, skipping the opening (it's already in the overview).
    for (let i = 1; i <= want - have; i++) take(d, Math.floor((i * d.chunks) / (want - have + 1)));
  }
  return new Map([...picked].map(([id, set]) => [id, [...set].sort((a, b) => a - b)]));
}

function sizeLabel({ pages, chars }) {
  if (pages) return `${pages} page${pages === 1 ? '' : 's'}`;
  const words = Math.round(chars / 5.5 / 1000);
  return words >= 1 ? `about ${words},000 words` : 'short';
}

function position(run, chunks, pageOf) {
  return pageOf?.(run.start, run.end) || `about ${Math.round((run.start / Math.max(chunks, 1)) * 100)}% of the way in`;
}

// The opening of a long document, shown with the message it was sent with.
export function overviewText({ name, pages, chars, opening }) {
  return (
    `[Long document they sent: "${name}" (${sizeLabel({ pages, chars })}). It's too long to read all at once: here is how it ` +
    `starts, and parts that match what they say are added to their newest message.]\n${opening}`
  );
}

// Matching parts of a long document. parts: [{ seq, text }] in order; neighbours are joined back together.
export function excerptText({ name, pages, chars, chunks, parts, pageOf, older = false }) {
  const runs = [];
  for (const p of parts) {
    const last = runs.at(-1);
    if (last && p.seq === last.end + 1) {
      last.text += p.text;
      last.end = p.seq;
    } else {
      runs.push({ start: p.seq, end: p.seq, text: p.text });
    }
  }
  const head = older
    ? `[Parts of "${name}", a document they sent earlier (${sizeLabel({ pages, chars })}), that match what they just said:]`
    : `[Parts of "${name}" (${sizeLabel({ pages, chars })}) that may be relevant to what they just said:]`;
  const body = runs.map((r) => `--- ${position(r, chunks, pageOf)} ---\n${r.text.trim()}`).join('\n');
  return `${head}\n${body}\n[You can't see the rest of it right now. If they ask about a part you can't see, say so and ask which part they mean (a page, a chapter, or a phrase from it).]`;
}

// Page label for a run of parts ("page 4" or "pages 4–5"), from the character offset where each page starts
// (PDFs on the Node server).
export function pageLookup(parts, pageStarts) {
  if (!pageStarts?.length) return null;
  const pageAt = (at) => {
    let lo = 0;
    let hi = pageStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (pageStarts[mid] <= at) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  return (first, last = first) => {
    if (!parts[first] || !parts[last]) return null;
    const a = pageAt(parts[first][0]);
    const b = pageAt(Math.max(parts[last][1] - 1, parts[first][0]));
    return a === b ? `page ${a}` : `pages ${a}–${b}`;
  };
}

// What to search documents for: the messages being answered, or (for a bare "why?") the one before them.
export function searchTextFor(messages) {
  let lastReply = -1;
  messages.forEach((m, i) => m.role === 'assistant' && (lastReply = i));
  const userText = (list) => list.filter((m) => m.role === 'user').map((m) => m.text || '');
  const pending = userText(messages.slice(lastReply + 1)).join(' ');
  if (queryTerms(pending).length) return pending;
  return userText(messages.slice(0, lastReply + 1)).at(-1) || '';
}
