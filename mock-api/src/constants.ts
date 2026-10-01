/**
 * Constants that encode master-spec invariants. These strings are contractual:
 * the backend/ Spring Boot implementation must use the identical values, and the
 * eval harness asserts on them. Do not paraphrase.
 */

/** R4 — exact fallback sentence when evidence is insufficient. Verbatim, no variations. */
export const R4_FALLBACK_EN =
  'I could not find sufficient information in the authorized knowledge base to answer this reliably.';

/** R4 — Hindi rendering of the same fallback. Same meaning, same commitment. */
export const R4_FALLBACK_HI =
  'मुझे इसका विश्वसनीय उत्तर देने के लिए अधिकृत ज्ञान-कोष में पर्याप्त जानकारी नहीं मिली।';

/** R5 — label that must accompany recommendations, reports and guides. */
export const R5_DISCLAIMER_EN = 'Informational — verify against current official sources';
export const R5_DISCLAIMER_HI = 'सूचनात्मक — कृपया वर्तमान आधिकारिक स्रोतों से सत्यापित करें';

/** Official channels we may point to when we cannot answer (R4 pointer). */
export const OFFICIAL_CHANNELS = [
  {
    id: 'bis-contact',
    labelEn: 'BIS contact / grievance portal',
    labelHi: 'बीआईएस संपर्क / शिकायत पोर्टल',
    url: 'https://www.bis.gov.in/',
    note: 'Listed for direction only. URLs are surfaced from the knowledge base once ingested; this entry is a placeholder until P0 seeds verified sources.',
    verified: false,
  },
] as const;

/** R7 — verification statuses. */
export const VERIFICATION_STATUSES = [
  'UNVERIFIED',
  'VERIFIED',
  'RESTRICTED',
  'OUTDATED',
  'SUPERSEDED',
] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

/** §5 — evidence tiers, computed by rule, never self-rated by the model. */
export const EVIDENCE_TIERS = ['STRONG', 'PARTIAL', 'NONE'] as const;
export type EvidenceTier = (typeof EVIDENCE_TIERS)[number];

/** §4 — roles. ADMIN implies CONTENT_MANAGER. */
export const ROLES = ['USER', 'CONTENT_MANAGER', 'ADMIN'] as const;
export type Role = (typeof ROLES)[number];

/** Role implication graph used by every authorisation check. */
export const ROLE_IMPLIES: Record<Role, readonly Role[]> = {
  USER: ['USER'],
  CONTENT_MANAGER: ['CONTENT_MANAGER', 'USER'],
  ADMIN: ['ADMIN', 'CONTENT_MANAGER', 'USER'],
};

/** §1 — personas. A profile field, NOT a permission. */
export const PERSONAS = [
  'CONSUMER',
  'MSME_MANUFACTURER',
  'JEWELLER_RETAILER',
  'STUDENT_ENGINEER',
] as const;
export type Persona = (typeof PERSONAS)[number];

/** §5 — routed intents. */
export const INTENTS = [
  'chitchat',
  'meta',
  'factual',
  'recommend',
  'certification',
  'hallmarking',
  'lab',
  'clarify',
  'out_of_scope',
] as const;
export type Intent = (typeof INTENTS)[number];

export const SUPPORTED_LANGUAGES = ['en', 'hi'] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];

/** Cookie + header names, shared with the frontend. */
export const REFRESH_COOKIE = 'bs_refresh';
export const CSRF_COOKIE = 'XSRF-TOKEN';
export const CSRF_HEADER = 'x-xsrf-token';

/** Error codes — see docs/API.md. */
export const ERROR_CODES = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  REFRESH_REUSED: 'REFRESH_REUSED',
  FORBIDDEN: 'FORBIDDEN',
  CSRF_FAILED: 'CSRF_FAILED',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  OUT_OF_SCOPE: 'OUT_OF_SCOPE',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
} as const;
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
