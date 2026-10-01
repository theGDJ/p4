import { redactString } from '../lib/logger';
import { detectLanguage } from './intent';
import { uwords, ustart } from './regex';

/**
 * Scope guard and PII guard (feature #7, P1).
 *
 * - Scope: out-of-domain requests are refused politely and **without retrieval**,
 *   so we never spend tokens trying to ground an answer we must not give, and we
 *   never drift into general-knowledge answers that would breach R1.
 * - PII: personal data is redacted before it reaches logs or the gap queue
 *   (§6 #14 stores PII-redacted queries). We do NOT lecture the user beyond a
 *   short, useful warning when they appear to have shared something sensitive.
 */

/* ------------------------------------------------------------- scope guard */

/**
 * Domain vocabulary. Compiled with `uwords()` — a plain `\b` is ASCII-only, so the
 * Devanagari alternatives below would never match and Hindi questions would be
 * misjudged as out of scope.
 */
const IN_SCOPE_HINTS = uwords(
  'bis|bureau of indian standards|indian standard|is ?\\d{3,5}|standard|standards|specification|clause|hallmark|hallmarking|huid|isi ?mark|crs|qco|quality control order|certify|certification|certified|licence|license|conformity|conformity assessment|accreditation|nabl|testing lab|laboratory|laboratories|product quality|product safety|manak|प्रमाणन|मानक|मानकों|हॉलमार्क|लाइसेंस|गुणवत्ता|प्रयोगशाला|आईएसआई|अनुपालन|विनिर्देश',
);

/** Domains that are unambiguously not about Indian Standards or BIS services. */
const CODING_LANGUAGE = uwords('python|javascript|typescript|java|sql|regex|kubernetes|npm|dockerfile');
const CODING_ARTIFACT = uwords('code|script|function|program|query|compile|debug');
const CODING_VERB = ustart('write|generate|fix|debug|refactor|convert');

const OUT_OF_SCOPE_PATTERNS: Array<{ id: string; test: (t: string) => boolean }> = [
  { id: 'weather', test: (t) => uwords('weather|forecast|rain|temperature today|मौसम|बारिश').test(t) },
  { id: 'sports', test: (t) => uwords('cricket|football score|match result|world cup|ipl|क्रिकेट|मैच').test(t) },
  { id: 'entertainment', test: (t) => uwords('movie|film review|song lyrics|bollywood|netflix|फिल्म|गाना').test(t) },
  {
    id: 'finance_advice',
    test: (t) => uwords('share price|stock tip|mutual fund|crypto|bitcoin|शेयर|क्रिप्टो').test(t) || ustart('invest in|buy shares').test(t),
  },
  { id: 'medical_advice', test: (t) => uwords('diagnose|prescription|dose|symptoms|इलाज|दवा|लक्षण').test(t) },
  { id: 'legal_advice', test: (t) => uwords('sue someone|legal notice|court case|मुकदमा|वकील').test(t) },
  {
    id: 'coding',
    // Two-sided: a language near an artifact, or a coding verb near an artifact.
    // The single-sided version missed "write me a python script".
    test: (t) =>
      (CODING_LANGUAGE.test(t) && CODING_ARTIFACT.test(t)) ||
      (CODING_VERB.test(t) && CODING_ARTIFACT.test(t)),
  },
  {
    id: 'personal_tasks',
    test: (t) =>
      uwords('homework|recipe|itinerary|रेसिपी').test(t) ||
      (ustart('write|plan').test(t) && uwords('essay|trip|poem|story|निबंध|यात्रा').test(t)),
  },
  { id: 'elections_politics', test: (t) => uwords('election result|political party|चुनाव परिणाम').test(t) },
];

export type ScopeVerdict =
  | { inScope: true; reason: string }
  | { inScope: false; topicId: string; reason: string };

/**
 * A request is in scope if it mentions the BIS domain at all, or if it is a
 * follow-up in an already-scoped conversation (the caller passes
 * `conversationInScope`). Being liberal here is safe: an in-scope question with
 * no evidence still ends in the R4 fallback rather than an invented answer.
 */
export function assessScope(text: string, conversationInScope = false): ScopeVerdict {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { inScope: true, reason: 'empty input handled upstream' };

  if (IN_SCOPE_HINTS.test(trimmed)) return { inScope: true, reason: 'domain terms present' };
  if (conversationInScope) return { inScope: true, reason: 'follow-up in a scoped conversation' };

  for (const { id, test } of OUT_OF_SCOPE_PATTERNS) {
    if (test(trimmed)) return { inScope: false, topicId: id, reason: `matched out-of-scope topic ${id}` };
  }

  // No domain signal and no known off-topic pattern: treat as in scope but flag it.
  // Retrieval will decide; if nothing is found the R4 fallback applies.
  return { inScope: true, reason: 'no explicit domain signal; deferring to retrieval' };
}

const REFUSAL = {
  en: 'I can only help with Indian Standards (BIS) and BIS services such as certification, hallmarking, CRS, Quality Control Orders and recognised testing laboratories. I am not able to help with that request.',
  hi: 'मैं केवल भारतीय मानक (BIS) और BIS सेवाओं — जैसे प्रमाणन, हॉलमार्किंग, CRS, गुणवत्ता नियंत्रण आदेश और मान्यता प्राप्त परीक्षण प्रयोगशालाएँ — के बारे में सहायता कर सकता हूँ। इस अनुरोध में मैं मदद नहीं कर पाऊँगा।',
} as const;

export function scopeRefusal(language: 'en' | 'hi'): string {
  return language === 'hi' ? REFUSAL.hi : REFUSAL.en;
}

/* ---------------------------------------------------------------- PII guard */

export interface PiiFinding {
  type: 'email' | 'phone' | 'aadhaar_like' | 'pan_like' | 'card_like' | 'free_text_secret';
  count: number;
}

const PII_DETECTORS: Array<{ type: PiiFinding['type']; re: RegExp }> = [
  { type: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { type: 'aadhaar_like', re: /(?<!\d)\d{4}[\s-]?\d{4}[\s-]?\d{4}(?!\d)/g },
  { type: 'pan_like', re: /\b[A-Z]{5}\d{4}[A-Z]\b/g },
  { type: 'card_like', re: /(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g },
  { type: 'phone', re: /(?<!\d)(?:\+91[-\s]?|0[-]?)?\d{5}[-\s]?\d{5}(?!\d)/g },
  {
    type: 'free_text_secret',
    re: /\b(password|passwd|otp|cvv|pin)\s*[:=]?\s*\S+/gi,
  },
];

/** Detects personal data in user-supplied text. Reports types and counts only — never the values. */
export function detectPii(text: string): PiiFinding[] {
  const findings: PiiFinding[] = [];
  for (const { type, re } of PII_DETECTORS) {
    const matches = text.match(new RegExp(re.source, re.flags));
    if (matches && matches.length > 0) findings.push({ type, count: matches.length });
  }
  // Aadhaar-like also matches card-like; keep the more specific one only.
  const aadhaar = findings.find((f) => f.type === 'aadhaar_like');
  if (aadhaar) {
    const card = findings.find((f) => f.type === 'card_like');
    if (card && card.count <= aadhaar.count) {
      return findings.filter((f) => f.type !== 'card_like');
    }
  }
  return findings;
}

/**
 * Redacts personal data so a query can be stored in the knowledge-gap queue or
 * written to logs (§6 #7, §8 "no secrets/PII in logs").
 */
export function redactPii(text: string): string {
  let out = text;
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]');
  out = out.replace(/(?<!\d)\d{4}[\s-]?\d{4}[\s-]?\d{4}(?!\d)/g, '[id-number]');
  out = out.replace(/\b[A-Z]{5}\d{4}[A-Z]\b/g, '[tax-id]');
  out = out.replace(/(?<!\d)(?:\+91[-\s]?|0[-]?)?\d{5}[-\s]?\d{5}(?!\d)/g, '[phone]');
  out = out.replace(/\b(password|passwd|otp|cvv|pin)(\s*[:=]?\s*)\S+/gi, '$1$2[secret]');
  // Second pass through the logger's redactor, which also strips JWTs.
  return redactString(out);
}

const PII_WARNING = {
  en: 'For your safety, please do not share personal identifiers (Aadhaar, PAN, phone number, email, passwords) in the chat. I have removed them from what gets stored.',
  hi: 'आपकी सुरक्षा के लिए, कृपया चैट में व्यक्तिगत पहचान-संख्याएँ (आधार, पैन, फ़ोन नंबर, ईमेल, पासवर्ड) साझा न करें। मैंने उन्हें सहेजी जाने वाली सामग्री से हटा दिया है।',
} as const;

export function piiWarning(language: 'en' | 'hi'): string {
  return language === 'hi' ? PII_WARNING.hi : PII_WARNING.en;
}

/** One call that classifies a raw question for routing, logging and storage. */
export function sanitiseInput(raw: string): {
  text: string;
  language: 'en' | 'hi';
  pii: PiiFinding[];
  redactedForLogs: string;
} {
  const language = detectLanguage(raw);
  const pii = detectPii(raw);
  return {
    text: raw,
    language,
    pii,
    redactedForLogs: redactPii(raw),
  };
}
