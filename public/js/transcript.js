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

// Adds a newly heard piece to the text so far. Losing something they said is far worse than repeating a word,
// so a piece only replaces the text when it starts with exactly the same words (everything so far again, plus
// more), and is only dropped when it exactly repeats the end of what's there.
export function mergePiece(acc, piece) {
  const seg = String(piece || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!seg) return acc;
  if (!acc) return seg;
  const a = words(acc);
  const s = words(seg);
  if (!s.length) return acc;
  const same = (x, y) => x.length === y.length && x.every((w, i) => w === y[i]);
  // Everything so far again, plus more.
  if (s.length >= a.length && same(a, s.slice(0, a.length))) return seg;
  // An exact repeat of the end of what's already there. (A single repeated word, as in "no, no", is kept.)
  if (s.length <= a.length && (s.length >= 2 || s.length === a.length) && same(s, a.slice(a.length - s.length))) return acc;
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
