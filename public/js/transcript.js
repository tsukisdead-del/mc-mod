// Joining up what speech recognition heard. Browsers report it differently: Chrome sends separate pieces,
// while iPhone Safari can send a piece it already sent again, or send everything said so far as one new piece.
// Plain functions with no browser APIs, so they're tested in Node (test/shared.test.js).

export function words(s) {
  return (
    String(s || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/\p{M}+/gu, '')
      .match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu) || []
  );
}

// Length of the longest common subsequence of two word lists: how much of one appears, in order, in the other.
function common(a, b) {
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const row = [0];
    for (let j = 1; j <= b.length; j++) row[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], row[j - 1]);
    prev = row;
  }
  return prev[b.length];
}

// Adds a newly heard piece to the text so far.
export function mergePiece(acc, piece) {
  const seg = String(piece || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!seg) return acc;
  if (!acc) return seg;
  const a = words(acc);
  const s = words(seg);
  if (!s.length) return acc;
  // Everything so far again, plus more (recognizers also fix earlier words, so allow some to differ).
  if (s.length >= a.length && common(a, s.slice(0, a.length + 2)) >= Math.ceil(a.length * 0.6)) return seg;
  // A repeat of the end of what's already there. (A single repeated word, as in "no, no", is kept.)
  if (s.length <= a.length && (s.length >= 2 || s.length === a.length) && common(s, a.slice(-(s.length + 1))) >= Math.ceil(s.length * 0.8)) {
    return acc;
  }
  return `${acc} ${seg}`;
}

// The whole transcript from a SpeechRecognition result list (rebuilt each time, so it's safe to call often).
export function assemble(results) {
  let finals = '';
  let interim = '';
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const t = r[0]?.transcript || '';
    if (r.isFinal) finals = mergePiece(finals, t);
    else interim += t;
  }
  return mergePiece(finals, interim);
}

// Speech recognition often mishears "Dr. Mochi" (e.g. "Dr. emoji"); put the therapist's name back.
const MOCHI_MISHEARINGS = /\b(dr\.?|doctor)\s+(emoji|emojis|moji|mochee|mochie|mochy|moshi|motchi|mo chi|mocha)\b/gi;
export function fixName(text, therapistName = '') {
  if (!/^dr\.?\s+mochi$/i.test(therapistName.trim())) return text;
  return text.replace(MOCHI_MISHEARINGS, therapistName.trim());
}
