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
