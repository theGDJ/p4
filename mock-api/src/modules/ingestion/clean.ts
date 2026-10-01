/**
 * Text sanitisation and instruction-injection flagging (§5 "clean + sanitise
 * (strip hidden text/control chars; flag instruction-like strings)").
 *
 * Two separate operations, deliberately:
 *
 * **Removed** — characters that carry no meaning and exist to hide or reorder
 * text: control codes, zero-width joiners, bidi overrides, soft hyphens, BOM,
 * tag characters. Removing them is *safe* for evidence because they are not part
 * of what the publisher wrote, and leaving them in lets a document read as
 * something other than what it displays. A Devanagari corpus is unaffected:
 * combining marks (matras), nukta, avagraha and the danda are all kept, and no
 * rule here uses `\b`, which in JavaScript is ASCII-only and would never see a
 * Hindi word boundary.
 *
 * **Flagged, not edited** — instruction-like strings. The stored chunk must stay
 * byte-for-byte the document as published (R2), so a sentence that says
 * "ignore the previous instructions" is preserved and reported to the reviewer
 * instead. The defence at answer time is structural: retrieved text is wrapped in
 * `<sources>` and labelled as data (R6), and the system prompt says text inside it
 * is data. A flag therefore means "a human must look before this is searchable".
 */

export interface InjectionFlag {
  rule: string;
  /** Short excerpt for the reviewer, with the surrounding context. */
  excerpt: string;
  at: number;
  severity: 'review' | 'block';
}

export interface SanitisedText {
  text: string;
  flags: InjectionFlag[];
  removed: { controlChars: number; invisibleChars: number; whitespaceRuns: number };
  /** True when anything at `block` severity was found — an admin must override to proceed. */
  requiresReview: boolean;
}

/** Control characters other than tab/LF/CR, plus DEL. */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F]/g;
/**
 * Format and invisible characters. `\u202A-\u202E` are the bidi controls that make
 * a line display differently from its bytes (the classic hidden-instruction
 * trick); `\u{E0000}-\u{E007F}` are Unicode "tag" characters, invisible and
 * historically used for the same effect.
 */
const INVISIBLE =
  /[\u00AD\u034F\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFEFF\u{E0000}-\u{E007F}]/gu;

/**
 * Injection detectors. English rules use `\b` freely — those words are ASCII.
 * Hindi rules use explicit character-class boundaries for the same reason
 * `\bपानी\b` can never match.
 */
interface Rule {
  id: string;
  re: RegExp;
  severity: 'review' | 'block';
}

const hindiBoundary = '(?:^|[^\\p{L}\\p{N}])';
/**
 * Hindi puts postpositions and case endings between the noun and the verb
 * (`निर्देशों को नज़रअंदाज़ करें`), so an ASCII-style `\b…\b` frame or a
 * "only punctuation between" window misses every natural sentence. The window is
 * therefore "up to 30 characters inside the same sentence" — the danda and the
 * newline end a sentence in Devanagari, exactly as in Latin script.
 */
const HINDI_SENTENCE_WINDOW = '[^।\\n]{0,30}?';

const RULES: Rule[] = [
  { id: 'override-instructions', re: /\b(?:ignore|disregard|forget|override)\b[\s\S]{0,40}?\b(?:previous|prior|above|earlier|all|any|system)\b[\s\S]{0,20}?\b(?:instructions?|rules?|directives?|prompts?|policy|policies)\b/i, severity: 'block' },
  { id: 'hindi-override-instructions', re: new RegExp(`${hindiBoundary}(?:निर्देश|नियम|आदेश)${HINDI_SENTENCE_WINDOW}(?:भूल|नज़रअंदाज़|नजरअंदाज|उपेक्षा|रद्द|बदल)`, 'iu'), severity: 'block' },
  { id: 'hindi-system-prompt', re: new RegExp(`${hindiBoundary}सिस्टम\\s*प्र[ॉा]म्प्ट`, 'iu'), severity: 'review' },
  { id: 'hindi-exfiltration', re: new RegExp(`${hindiBoundary}(?:अपना|तुमका|आपका)${HINDI_SENTENCE_WINDOW}((?:निर्देश|नियम|प्रॉम्प्ट)${HINDI_SENTENCE_WINDOW}(?:दिखा|बता|छाप|print))`, 'iu'), severity: 'block' },
  { id: 'role-reassignment', re: /\byou are (?:now|no longer|simply|just)\b/i, severity: 'block' },
  { id: 'new-instructions', re: /\bnew (?:system )?instructions?\s*:/i, severity: 'block' },
  { id: 'system-prompt-mention', re: /\b(?:system|developer)\s*prompt\b/i, severity: 'review' },
  { id: 'role-marker-line', re: /^[ \t]*(?:system|assistant|developer|tool)[ \t]*:[ \t]/im, severity: 'review' },
  { id: 'delimiter-escape', re: /<\/?\s*(?:sources|user_input|instruction)\s*>/i, severity: 'block' },
  { id: 'exfiltration', re: /\b(?:reveal|print|repeat|show|output)\b[\s\S]{0,30}?\b(?:your|the)\b[\s\S]{0,30}?\b(?:instructions?|system prompt|rules?|hidden)\b/i, severity: 'block' },
  { id: 'citation-suppression', re: /\b(?:do not|don't|never)\b[\s\S]{0,24}?\bcit(?:e|ing|ations?)\b/i, severity: 'block' },
  { id: 'tool-call-syntax', re: /<\/?\s*(?:function_call|tool_call|invoke)\b|^\s*TOOL\s*:/im, severity: 'block' },
  { id: 'credential-shaped', re: /\b(?:sk|pk|api[_-]?key|secret)[-_][A-Za-z0-9]{16,}\b|AKIA[0-9A-Z]{16}\b|ghp_[A-Za-z0-9]{20,}\b/i, severity: 'block' },
  { id: 'url-shortener', re: /\b(?:bit\.ly|tinyurl\.com|t\.co|goo\.gl|cutt\.ly)\/\S*/i, severity: 'review' },
];

export function sanitise(raw: string): SanitisedText {
  const before = raw.length;
  let text = raw.replace(/\r\n?/g, '\n');

  let controlChars = 0;
  text = text.replace(CONTROL, () => {
    controlChars += 1;
    return '';
  });

  let invisibleChars = 0;
  text = text.replace(INVISIBLE, () => {
    invisibleChars += 1;
    return '';
  });

  let whitespaceRuns = 0;
  text = text
    .replace(/[ \t]{2,}/g, () => {
      whitespaceRuns += 1;
      return ' ';
    })
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Both texts are scanned. After the invisible characters are gone, `10500` and
  // `ignore` can end up adjacent, which defeats a word-boundary rule — so a detector
  // run only on the cleaned text would miss the exact attack the cleaning exists to
  // defuse. Offsets from the raw pass are approximate and labelled as such.
  const flags = mergeFlags(detectInstructionLike(raw, 'raw'), detectInstructionLike(text, 'cleaned'));

  if (invisibleChars > 0 || controlChars > 0) {
    // Nothing in a real Indian Standard needs a bidi override or a control byte, so
    // the removal itself is the finding a reviewer should see, not a silent edit.
    flags.push({
      rule: 'invisible-or-control-characters-removed',
      excerpt: `${invisibleChars} invisible and ${controlChars} control character(s) were removed from this document`,
      at: 0,
      severity: 'review',
    });
  }

  const requiresReview = flags.some((f) => f.severity === 'block');

  return {
    text,
    flags,
    removed: { controlChars, invisibleChars, whitespaceRuns },
    requiresReview,
  };
}

/** Union by rule + excerpt prefix, keeping the earliest occurrence of each finding. */
function mergeFlags(a: InjectionFlag[], b: InjectionFlag[]): InjectionFlag[] {
  const out: InjectionFlag[] = [];
  const seen = new Set<string>();
  for (const flag of [...a, ...b]) {
    const key = `${flag.rule}|${flag.excerpt.slice(0, 40).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(flag);
  }
  return out.sort((x, y) => x.at - y.at);
}

/** Runs the detectors over `text` and returns de-duplicated, positioned findings. */
export function detectInstructionLike(text: string, _source: 'raw' | 'cleaned' = 'cleaned'): InjectionFlag[] {
  const flags: InjectionFlag[] = [];
  for (const rule of RULES) {
    // Fresh regex per rule per call: a shared `/g` or `/m` object carries mutable
    // `lastIndex` state, which silently skips matches on the next use.
    const re = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : rule.re.flags + 'g');
    for (const m of text.matchAll(re)) {
      const at = m.index ?? 0;
      const excerpt = text.slice(Math.max(0, at - 30), at + Math.min(m[0].length + 30, 110)).replace(/\n/g, ' ');
      flags.push({ rule: rule.id, excerpt: excerpt.trim(), at, severity: rule.severity });
      if (flags.length >= 25) return flags; // a hostile document need not be enumerated fully
    }
  }
  return flags.sort((a, b) => a.at - b.at);
}

/**
 * Drops boilerplate that repeats on most pages/lines — the running header and
 * footer of a standard PDF, which otherwise becomes a "chunk" of its own and
 * pollutes FTS scoring. A line is boilerplate when it is short and appears on at
 * least this fraction of the blocks, on both first and last positions.
 */
export function stripRepeatingBoilerplate(blocks: string[], fraction = 0.6): { blocks: string[]; removed: string[] } {
  if (blocks.length < 4) return { blocks, removed: [] };

  const edgeLinesOf = (block: string): string[] => {
    const lines = block.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    if (lines.length === 0) return [];
    return lines.length === 1 ? lines : [lines[0]!, lines[lines.length - 1]!];
  };

  const counts = new Map<string, number>();
  for (const block of blocks) {
    for (const line of edgeLinesOf(block)) {
      const key = normaliseKey(line);
      if (!key || key.length > 120) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const threshold = Math.max(3, Math.ceil(blocks.length * fraction));
  const boiler = new Set([...counts.entries()].filter(([, n]) => n >= threshold).map(([k]) => k));
  if (boiler.size === 0) return { blocks, removed: [] };

  const removed: string[] = [];
  const kept: string[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const isBoiler = (line: string): boolean => {
      const key = normaliseKey(line.trim());
      return !!key && boiler.has(key) && line.trim().length <= 140;
    };
    const survivors = lines.filter((line) => {
      if (isBoiler(line)) {
        removed.push(line.trim());
        return false;
      }
      return true;
    });
    let text = survivors.join('\n').trim();
    const nonEmpty = lines.map((line) => line.trim()).filter((line) => line.length > 0);
    if (text.length === 0 && nonEmpty.length > 1) {
      // Every line of a multi-line block looked like boilerplate. Keeping its longest
      // line is the safe failure: eating a page of real content because two of its
      // sentences also appear elsewhere is far worse than keeping one repeated banner.
      // A block that is *only* the banner (nonEmpty.length === 1) is boilerplate from
      // end to end and goes away with it — that is what a repeated cover page is.
      const longest = [...nonEmpty].sort((a, b) => b.length - a.length)[0]!;
      const idx = removed.lastIndexOf(longest);
      if (idx >= 0) removed.splice(idx, 1);
      text = longest;
    }
    if (text.length > 0) kept.push(text);
  }
  return { blocks: kept, removed };
}

function normaliseKey(line: string): string {
  const t = line.trim().toLowerCase().replace(/\s+/g, ' ');
  // Page numbers ("3", "Page 3 of 12") are boilerplate by construction.
  return t.replace(/^page\s*\d+(\s+of\s+\d+)?$/i, 'page').replace(/\d+/g, '#');
}

/**
 * Sanity check used by tests and by the review UI: after `sanitise()` nothing
 * invisible should remain. Both regexes are non-global here on purpose — a `/g`
 * object would carry `lastIndex` between calls and report a false negative.
 */
export function containsInvisible(text: string): boolean {
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F]/.test(text)
    || /[\u00AD\u034F\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFEFF]/u.test(text);
}

/** How much of the raw text was whitespace/control noise, for the job's warning line. */
export function removedRatio(before: number, after: number): number {
  if (before <= 0) return 0;
  return Number((1 - after / before).toFixed(4));
}
