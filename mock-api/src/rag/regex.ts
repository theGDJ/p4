/**
 * Unicode-aware word boundaries.
 *
 * **Why this file exists.** JavaScript's `\b` is defined in terms of `\w`, which is
 * `[A-Za-z0-9_]` only — even with the `u` flag. Devanagari characters are therefore
 * all "non-word", so `\bपानी\b` can NEVER match: both boundaries fail against
 * non-word neighbours. Every Hindi keyword rule written with `\b` was silently dead,
 * which would have broken the bilingual hero workflow (§1) and the P3 "Hindi
 * end-to-end" exit gate without raising a single error.
 *
 * `uwords()` replaces `\b` with lookarounds over the Unicode letter/number classes,
 * so boundaries behave the same for Latin and Devanagari text.
 */

/** Left/right Unicode word boundary as raw pattern source. */
export const UWB_LEFT = '(?<![\\p{L}\\p{N}_])';
export const UWB_RIGHT = '(?![\\p{L}\\p{N}_])';

/** Wraps an alternation in Unicode-aware word boundaries. */
export function uwb(inner: string): string {
  return `${UWB_LEFT}(?:${inner})${UWB_RIGHT}`;
}

function normaliseFlags(flags: string): string {
  const set = new Set(flags);
  set.add('u'); // required for \p{...} and for correct Devanagari handling
  return [...set].join('');
}

/**
 * Compiles an alternation as a whole-word matcher that works for English AND Hindi.
 *
 *   uwords('water|पानी')      // matches "water", "पानी", not "waterfall"/"पानीय"
 */
export function uwords(alternation: string, flags = 'i'): RegExp {
  return new RegExp(uwb(alternation), normaliseFlags(flags));
}

/**
 * Compiles a pattern where only the leading edge needs a boundary, for phrases
 * bridged by a gap (e.g. `<language> ... <artifact>`). The trailing edge is left
 * open on purpose so the bridge can span arbitrary text.
 */
export function ustart(alternation: string, flags = 'i'): RegExp {
  return new RegExp(`${UWB_LEFT}(?:${alternation})`, normaliseFlags(flags));
}

/**
 * A message that names a standard is self-identifying: the subject of the question is
 * already fixed, which is the one thing the clarification engine would ask for (§6 #8).
 *
 * Two modules need this exact judgement — the router (do not ask for a product when the
 * IS number is given) and the query rewriter (do not spend a model call resolving
 * "it" when the standard is already in the text). Keeping the pattern here means the
 * two can never disagree about what "already specific" means.
 */
export const STANDARD_MENTION = /\bIS\s?\d{3,5}\b|\bIS\s?\d{3,5}\s*[:-]\s*\d{4}\b|\bSP\s?\d+\b|\bPart\s\d+\b/iu;

/** True when the text cites an Indian Standard (or a BIS SP / Part number) directly. */
export function namesStandard(text: string): boolean {
  return STANDARD_MENTION.test(text);
}
