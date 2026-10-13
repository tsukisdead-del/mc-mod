// Long documents: split them into parts, find the parts that match what they said, and decide how much of each
// document the model sees. Pure functions (no Node or Worker APIs), shared by the Node server, the Cloudflare
// Worker and the tests.

// About 500 tokens of English per part: small enough to send several, big enough to keep a passage together.
export const CHUNK_CHARS = 2000;

// How much document text each kind of model gets per reply, in estimated tokens.
// - inlineFresh/inlineOlder: documents are sent whole while they fit in this (smallest first, separately for
//   the documents just sent and older recent ones); the rest are "long": their opening goes with the message
//   they came with, and parts that match what they say are added to their newest message.
// - stable: one pool for all recent documents, oldest first, so a document shown whole stays whole (Claude's
//   prompt cache depends on earlier messages not changing).
// - excerpts: room for those matching parts across all long documents. maxParts caps how many.
// - overview: the opening shown for a long document.
export const DOC_BUDGETS = {
  // Free Workers AI: every token spends the daily allowance.
  free: { inlineFresh: 11000, inlineOlder: 3500, excerpts: 4500, overview: 450, maxParts: 8 },
  // Claude: a 1M-token window, but each reply is billed, so whole documents only up to a point.
  claude: { inlineFresh: 100000, inlineOlder: 100000, excerpts: 20000, overview: 1500, maxParts: 30, stable: true },
  // Ollama with a 16k-token window (scaled for other window sizes with scaleBudget).
  local: { inlineFresh: 4000, inlineOlder: 1200, excerpts: 2600, overview: 350, maxParts: 6 },
};

export function scaleBudget(budget, factor) {
  const out = { ...budget };
  for (const k of ['inlineFresh', 'inlineOlder', 'excerpts', 'overview']) out[k] = Math.round(budget[k] * factor);
  return out;
}

// ---------- splitting ----------

const isHighSurrogate = (c) => c >= 0xd800 && c <= 0xdbff;

// The first `n` characters, without cutting an emoji (or other two-unit character) in half.
export function clip(text, n) {
  const s = String(text || '');
  if (s.length <= n) return s;
  return s.slice(0, isHighSurrogate(s.charCodeAt(n - 1)) ? n - 1 : n);
}

// Splits text into consecutive [start, end) parts of about `size` characters, cutting at a paragraph break,
// else a sentence end, else a line break or space. The parts cover the text exactly (joined, they are the text).
// Each search looks only inside the part's own window, so a whole book splits in a few milliseconds.
export function chunkText(text, size = CHUNK_CHARS) {
  const parts = [];
  const n = text.length;
  let start = 0;
  while (start < n) {
    let end = Math.min(start + size, n);
    if (end < n) {
      const min = start + Math.floor(size * 0.6);
      const win = text.slice(min, end);
      const cut = (s) => {
        const i = win.lastIndexOf(s);
        return i >= 0 ? min + i + s.length : -1;
      };
      let at = cut('\n\n');
      if (at < 0) at = Math.max(cut('. '), cut('? '), cut('! '), cut('.\n'), cut('。'), cut('！'), cut('？'));
      if (at < 0) at = cut('\n');
      if (at < 0) at = cut(' ');
      if (at > 0) end = at;
      if (isHighSurrogate(text.charCodeAt(end - 1))) end--;
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
// Scripts written without spaces between words (and Korean, whose words are long): character pairs are the "words".
const NO_SPACES = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
// A quick check for those scripts (Thai, Lao, Myanmar, Khmer, kana, CJK, Hangul) before doing the slower work.
const MAYBE_NO_SPACES = /[฀-໿က-႟ក-៿぀-ヿ㐀-鿿가-힯豈-﫿]/;
const WORD = /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*(?:['’]\p{L}+)?/gu;

// Lowercase, with accents taken off Latin letters only (é -> e); other scripts keep their marks (й, Hindi vowels).
function normalize(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/(\p{Script=Latin})\p{M}+/gu, '$1')
    .normalize('NFC')
    .toLowerCase();
}

function pairs(word) {
  const chars = [...word];
  if (chars.length === 1) return [word];
  const out = [];
  for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i] + chars[i + 1]);
  return out;
}

function fold(w) {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

// Search words, with common words dropped. fold: plural folding for the Node index (the Worker's index stems).
export function tokenize(text, { fold: folding = true } = {}) {
  const out = [];
  for (const m of normalize(text).matchAll(WORD)) {
    const w = m[0].replace(/['’].*$/, '');
    if (NO_SPACES.test(w)) {
      out.push(...pairs(w));
      continue;
    }
    if (w.length < 2 || STOPWORDS.has(w)) continue;
    out.push(folding ? fold(w) : w);
  }
  return out;
}

// The words to search for: distinct, in the order they were said, keeping the last `max` (questions tend to
// come at the end of a long message).
export function queryTerms(text, { max = 24, fold: folding = true } = {}) {
  return [...new Set(tokenize(text, { fold: folding }))].slice(-max);
}

// A D1 full-text (FTS5) query: each word quoted, joined with OR. Raw text could be a syntax error.
export function ftsQuery(terms) {
  return terms
    .map((t) => t.replace(/"/g, ''))
    .filter(Boolean)
    .map((t) => `"${t}"`)
    .join(' OR ');
}

// For the Worker's index: the character pairs of any no-space-script text in a part (its normal index treats a
// whole run of such text as one word), or null when there is none.
export function searchForm(text) {
  if (!MAYBE_NO_SPACES.test(text)) return null;
  const out = [];
  for (const m of normalize(text).matchAll(WORD)) if (NO_SPACES.test(m[0])) out.push(...pairs(m[0]));
  return out.length ? out.join(' ') : null;
}

// How many different search words a part contains.
export function matchedTerms(text, terms) {
  const have = new Set(tokenize(text));
  return terms.filter((t) => have.has(t)).length;
}

// ---------- what they're asking about ----------

const DOC_WORDS =
  /\b(book|books|novel|chapter|chapters|page|pages|journal|journals|diary|notes?|essay|letter|letters|poem|poems|story|stories|document|documents|doc|docs|file|files|pdf|article|report|worksheet|paper|thesis|manuscript|script|passage|quote|section|you read|i sent|i shared|i showed|i gave you|it says?|it said|says in|wrote|written|remember)\b/i;

// Does their message seem to be about a document? (Older documents are only searched then; otherwise everyday
// messages would keep pulling in passages that happen to share a word.)
export function refersToDocuments(text, names = []) {
  const s = String(text || '');
  if (DOC_WORDS.test(s)) return true;
  if (/["“][^"”]{4,}["”]/.test(s)) return true; // a quoted phrase
  // A capitalised word that doesn't start a sentence: probably a name (of a person or place in it).
  if (/[^.!?\s]\s+(?!I\b|I'|I’)[A-Z][\p{L}'’-]{2,}/u.test(s)) return true;
  const said = new Set(tokenize(s));
  return names.some((n) => tokenize(n.replace(/\.[a-z0-9]+$/i, '')).some((w) => w.length >= 4 && said.has(w)));
}

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const ORDINALS = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth'];

function roman(n) {
  const table = [
    [100, 'c'],
    [90, 'xc'],
    [50, 'l'],
    [40, 'xl'],
    [10, 'x'],
    [9, 'ix'],
    [5, 'v'],
    [4, 'iv'],
    [1, 'i'],
  ];
  let out = '';
  for (const [v, s] of table) while (n >= v) (out += s), (n -= v);
  return out;
}

function toNumber(word) {
  const w = word.toLowerCase();
  if (/^\d+$/.test(w)) return Number(w);
  const i = NUMBER_WORDS.indexOf(w);
  if (i > 0) return i;
  if (/^[ivxlc]+$/.test(w)) {
    for (let n = 1; n <= 150; n++) if (roman(n) === w) return n;
  }
  return null;
}

// "chapter 3", "the third chapter", "page 12" in their message.
export function structuralRefs(text) {
  const s = String(text || '');
  const chapters = new Set();
  const pagesSet = new Set();
  for (const m of s.matchAll(/\b(?:chapter|chap\.?|ch\.)\s*(\d{1,3}|[ivxlc]{1,7}|[a-z]+)\b/gi)) {
    const n = toNumber(m[1]);
    if (n) chapters.add(n);
  }
  for (const m of s.matchAll(/\b([a-z]+)\s+chapter\b/gi)) {
    const n = ORDINALS.indexOf(m[1].toLowerCase());
    if (n > 0) chapters.add(n);
  }
  for (const m of s.matchAll(/\b(?:page|pg\.?|p\.)\s*(\d{1,4})\b/gi)) pagesSet.add(Number(m[1]));
  return { chapters: [...chapters].slice(0, 3), pages: [...pagesSet].slice(0, 3) };
}

// The ways a chapter heading can be written, for searching: "chapter 3", "chapter iii", "chapter three".
export function chapterForms(n) {
  return [String(n), roman(n), NUMBER_WORDS[n]].filter(Boolean).map((f) => `chapter ${f}`);
}

// Where a chapter starts in the text (Node, which has the whole text): a heading at the start of a line if
// there is one, else the first mention. Returns a character offset or -1.
export function findChapter(text, n) {
  const forms = [String(n), roman(n), NUMBER_WORDS[n]].filter(Boolean).join('|');
  const heading = new RegExp(`(^|\\n)[ \\t#*]*chapter\\s+(?:${forms})\\b`, 'i').exec(text);
  if (heading) return heading.index + heading[1].length;
  const any = new RegExp(`\\bchapter\\s+(?:${forms})\\b`, 'i').exec(text);
  return any ? any.index : -1;
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
 * docs: [{ id, tokens, fresh, recent, order }] (fresh = sent with the messages being answered; recent = still
 * within the last few messages; order = when it was sent). Returns id -> 'inline' (send it whole), 'long'
 * (opening + matching parts) or 'search' (older: matching parts only, when they bring it up).
 */
export function planDocuments(docs, budget) {
  const plan = new Map();
  const fill = (list, total) => {
    let used = 0;
    for (const d of list) {
      const fits = used + d.tokens <= total;
      plan.set(d.id, fits ? 'inline' : 'long');
      if (fits) used += d.tokens;
    }
  };
  const recent = docs.filter((d) => d.fresh || d.recent);
  const bySize = (a, b) => a.tokens - b.tokens;
  if (budget.stable) {
    fill(
      [...recent].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
      budget.inlineFresh,
    );
  } else {
    fill(recent.filter((d) => d.fresh).sort(bySize), budget.inlineFresh);
    fill(recent.filter((d) => !d.fresh).sort(bySize), budget.inlineOlder);
  }
  for (const d of docs) if (!plan.has(d.id)) plan.set(d.id, 'search');
  return plan;
}

// Can at least one part of a document fit in the excerpt budget? (Tiny local windows can't.)
export function canShowParts(budget, cpt = 3.5, chunkChars = CHUNK_CHARS) {
  return budget.excerpts >= chunkChars / cpt;
}

/**
 * Which parts to show. matches: [{ docId, seq, score, forced? }] best first, across documents (forced: they
 * asked for that chapter or page). docs: [{ id, chunks, mode, fresh, cpt }] (cpt: characters per token).
 * A long document they just sent that matched little gets evenly spaced samples first (so "what's this
 * about?" works and older documents can't crowd it out), then the best matches until the budget is used.
 * Returns docId -> sorted seq list.
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
  for (const m of matches) if (m.forced && byId.has(m.docId)) take(byId.get(m.docId), m.seq);
  for (const d of docs) {
    if (d.mode !== 'long' || !d.fresh) continue;
    const found = matches.filter((m) => m.docId === d.id).length;
    if (found >= 2) continue;
    // Evenly spaced through the document, skipping the opening (it's already in the overview).
    const want = 4 - found;
    for (let i = 1; i <= want; i++) take(d, Math.floor((i * d.chunks) / (want + 1)));
  }
  for (const m of matches) {
    const d = byId.get(m.docId);
    if (d) take(d, m.seq);
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

// Document text goes to the model as their material, never as the app's own notes: a line in it that looks
// like one of those notes ("[App note: ...") is changed so it can't pass for one.
export function neutralize(text) {
  return String(text || '').replace(/^([ \t]*)\[(?=\s*(?:app note|document they sent|long document|parts of|they sent|you can't see))/gim, '$1(');
}

// The note that goes with a long document's opening. searchable: whether matching parts can be added later
// (otherwise the model is told to ask them to paste the part they mean).
export function overviewNote({ name, pages, chars, searchable = true }) {
  const how = searchable
    ? 'here is how it starts, and when they talk about something in it, the matching parts are added to their message.'
    : 'you can only see how it starts. If they ask about another part, ask them to paste it.';
  return `[Long document they sent: "${name}" (${sizeLabel({ pages, chars })}). It's too long to read all at once: ${how}]`;
}

// The opening of a long document, shown with the message it was sent with.
export function overviewText(args) {
  return `${overviewNote(args)}\n${neutralize(args.opening)}`;
}

// Matching parts of a long document, as { head, body, foot }. parts: [{ seq, text }] in order; neighbours are
// joined back together.
export function excerptPieces({ name, pages, chars, chunks, parts, pageOf, older = false }) {
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
  const body = runs.map((r) => `--- ${position(r, chunks, pageOf)} ---\n${neutralize(r.text.trim())}`).join('\n');
  const ask = pageOf ? 'a page number, a chapter, or a name or phrase from it' : 'a chapter, or a name or phrase from it';
  const foot = `[You can't see the rest of it right now. If they ask about a part you can't see, say so and ask for ${ask}.]`;
  return { head, body, foot };
}

export function excerptText(args) {
  const { head, body, foot } = excerptPieces(args);
  return `${head}\n${body}\n${foot}`;
}

// The same, as a Claude document block: their material kept apart from the conversation's own text.
export function excerptDocument(args) {
  const { head, body, foot } = excerptPieces(args);
  return { type: 'document', title: `Parts of ${args.name}`, context: `${head} ${foot}`, source: { type: 'text', media_type: 'text/plain', data: body } };
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

// The part where a character offset falls.
export function partAt(parts, offset) {
  let lo = 0;
  let hi = parts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (parts[mid][0] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// What to search documents for: the messages being answered, or (for a bare "why?") the one before them.
// When they just sent a document without saying much, that document is the topic: nothing older is searched.
export function searchTextFor(messages) {
  let lastReply = -1;
  messages.forEach((m, i) => m.role === 'assistant' && (lastReply = i));
  const pendingMessages = messages.slice(lastReply + 1).filter((m) => m.role === 'user');
  const pending = pendingMessages.map((m) => m.text || '').join(' ');
  if (queryTerms(pending).length || structuralRefs(pending).chapters.length || structuralRefs(pending).pages.length) return pending;
  if (pendingMessages.some((m) => m.attachments?.length)) return '';
  return (
    messages
      .slice(0, lastReply + 1)
      .filter((m) => m.role === 'user')
      .map((m) => m.text || '')
      .at(-1) || ''
  );
}

// Which matches to keep: everything for a document they just sent; for others, parts that contain at least two
// of the search words (one if they only used one), so a single shared everyday word doesn't pull a passage in.
export function relevant(matches, docs, terms) {
  const byId = new Map(docs.map((d) => [d.id, d]));
  const need = Math.min(2, terms.length);
  return matches.filter((m) => m.forced || byId.get(m.docId)?.fresh || matchedTerms(m.text || '', terms) >= need);
}
