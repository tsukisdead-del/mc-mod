// A keyword backstop for crisis language. The model is told to handle this itself; this makes sure the
// help card shows (and the model is reminded) even if a smaller model misses it.
const PATTERNS = [
  /\bsuicid/i,
  /\bkill(ing)? my ?self\b/i,
  /\bend(ing)? (my|it) (life|all)\b/i,
  /\bend it all\b/i,
  /\b(want|wanna|going) to die\b/i,
  /\b(don'?t|do not) want to (live|be alive|exist|wake up)\b/i,
  /\bbetter off (dead|without me)\b/i,
  /\bno (reason|point) (to|in) (live|living|go on)\b/i,
  /\b(hurt|harm|cut|cutting|burn|burning) my ?self\b/i,
  /\bself[- ]?harm/i,
  /\boverdos(e|ing)\b/i,
  /\bunalive\b/i,
];

export function looksLikeCrisis(text) {
  return typeof text === 'string' && PATTERNS.some((p) => p.test(text));
}

export const CRISIS_NOTE =
  '[App note: their last message may describe thoughts of suicide, self-harm, or being in danger. Follow the Safety section now: no jokes, check on their safety, share the crisis resources, and include the [[crisis]] tag.]';
