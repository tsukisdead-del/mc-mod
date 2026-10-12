// Shared by the server and the browser: turns the therapist's raw reply into
// separate text bubbles, a cartoon mood, and a crisis flag.
//
// Raw format from the model:
//   [[mood:happy]] first text
//   |||
//   second text [[crisis]]

export const MOODS = ['warm', 'happy', 'laughing', 'thinking', 'concerned', 'proud', 'curious'];
export const SPLIT = '|||';

export function parseReply(raw, { partial = false } = {}) {
  let text = String(raw || '');
  const moodMatch = text.match(/\[\[\s*mood\s*:\s*([a-z]+)\s*\]\]/i);
  const mood = moodMatch && MOODS.includes(moodMatch[1].toLowerCase()) ? moodMatch[1].toLowerCase() : null;
  const crisis = /\[\[\s*crisis\s*\]\]/i.test(text);

  text = text.replace(/\[\[[^\]\n]{0,40}\]\]/g, '');
  if (partial) {
    // Hide a tag or delimiter that's still arriving, e.g. "[[mo" or "||".
    text = text.replace(/\[\[?[^\]\n]{0,40}$/, '').replace(/\|{1,2}$/, '');
  }

  const parts = text.split(/\s*\|\|\|\s*/).map((s) => s.trim());
  return {
    mood,
    crisis,
    bubbles: parts.filter(Boolean),
    // While streaming: is the last bubble still being typed?
    open: partial && parts.length > 0 && parts[parts.length - 1] !== '',
  };
}

// Plain text for notifications / speech.
export function plainText(raw) {
  return parseReply(raw)
    .bubbles.join(' ')
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
