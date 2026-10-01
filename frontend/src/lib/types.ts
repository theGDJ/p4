/**
 * Types mirroring docs/API.md.
 *
 * These are the contract shared by the Spring Boot backend and the Node mock API.
 * If a field changes here, it must change in docs/API.md and in both servers.
 */

export type Role = 'USER' | 'CONTENT_MANAGER' | 'ADMIN';
export type Persona = 'CONSUMER' | 'MSME_MANUFACTURER' | 'JEWELLER_RETAILER' | 'STUDENT_ENGINEER';
export type Language = 'en' | 'hi';
export type EvidenceTier = 'STRONG' | 'PARTIAL' | 'NONE';
export type VerificationStatus = 'UNVERIFIED' | 'VERIFIED' | 'RESTRICTED' | 'OUTDATED' | 'SUPERSEDED';

export type Intent =
  | 'chitchat'
  | 'meta'
  | 'factual'
  | 'recommend'
  | 'certification'
  | 'hallmarking'
  | 'lab'
  | 'clarify'
  | 'out_of_scope';

export interface PublicUser {
  id: string;
  email: string;
  fullName: string;
  persona: Persona | null;
  language: Language;
  roles: Role[];
  emailVerified: boolean;
  createdAt: string;
}

export interface MeResponse extends PublicUser {
  locked: boolean;
  conversationCount: number;
}

export interface SessionResponse {
  user: PublicUser;
  accessToken: string;
  accessExpiresAt: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

export interface BootstrapResponse {
  app: {
    name: string;
    version: string;
    env: string;
    stack: string;
    /** True when no real model is configured; the UI must show a badge (R8/R10). */
    mockProvider: boolean;
    providerName: string;
  };
  auth: {
    accessTokenTtlMinutes: number;
    personas: Persona[];
    languages: Language[];
    passwordMinLength: number;
    lockoutAfterFailedAttempts: number;
    lockoutMinutes: number;
  };
  knowledge: {
    approvedDocuments: number;
    approvedChunks: number;
    kbVersion: number;
  };
  security: { passwordScheme: string; csrfEnabled: boolean };
  disclaimer: string;
}

/** A citation as shown in the evidence rail (feature #3). */
export interface SourceSnapshot {
  ref: string; // S1..S6
  chunkId: string;
  documentVersionId: string;
  title: string;
  standardNo: string | null;
  section: string | null;
  docType: string;
  language: Language;
  sourceUrl: string | null;
  verificationStatus: VerificationStatus;
  verifiedAt: string | null;
  snippet: string;
  score: number;
}

export interface Conversation {
  id: string;
  title: string;
  summary: string | null;
  language: Language;
  createdAt: string;
  updatedAt: string;
}

export interface MessageUsage {
  promptTokens: number;
  completionTokens: number;
  model: string | null;
  cacheHit: boolean;
  retrievalMs: number | null;
}

export interface Message {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  sources: SourceSnapshot[];
  evidenceTier: EvidenceTier;
  intent: Intent | null;
  language: Language;
  followUps: string[];
  error: string | null;
  usage: MessageUsage;
  createdAt: string;
}

export interface ConversationDetail extends Conversation {
  messages: Message[];
}

export interface ApiErrorDetail {
  field: string;
  issue: string;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: ApiErrorDetail[];
    traceRef: string;
  };
}

/* ---------------------------------------------------------------- SSE frames */

export interface SseMetaFrame {
  messageId: string;
  intent: Intent;
  language: Language;
  piiDetected: boolean;
  inScope: boolean;
}

export interface SseSourcesFrame {
  sources: SourceSnapshot[];
  evidenceTier: EvidenceTier;
}

export interface SseUsageFrame extends MessageUsage {
  costUsd: number;
  evidenceTier: EvidenceTier;
  contextTokens: number;
  kbVersion: number;
  systemPromptTokens: number;
  limits: { maxContextTokens: number; topK: number; llmProvider: string };
}

export interface SseDoneFrame {
  messageId: string;
  followUps: string[];
}

export interface SseErrorFrame {
  code: string;
  message: string;
}

export interface StreamHandlers {
  onMeta?: (frame: SseMetaFrame) => void;
  onDelta?: (text: string) => void;
  onSources?: (frame: SseSourcesFrame) => void;
  onUsage?: (frame: SseUsageFrame) => void;
  onDone?: (frame: SseDoneFrame) => void;
  onError?: (frame: SseErrorFrame) => void;
}

/* ------------------------------------------------------------------------- *
 * Admin read models (P1). Shapes mirror docs/API.md §"Admin endpoints" and the
 * mock-api responses byte for byte; the Spring backend must produce the same.
 * ------------------------------------------------------------------------- */

/** `GET /admin/knowledge/stats` — CONTENT_MANAGER and above. */
export interface KnowledgeStatsResponse {
  documents: number;
  chunks: number;
  kbVersion: number;
  jobs: number;
  /**
   * Coverage is derived from real ingestion state only. No projected or
   * illustrative percentage is ever published here (R10).
   */
  coverage: {
    derivedFrom: string;
    documentsApproved: number;
    note: string;
  };
}

/** One row of `GET /admin/audit-logs` — ADMIN only. */
export interface AuditLogEntry {
  id: string;
  actorUserId: string | null;
  actorRoles: Role[];
  action: string;
  entityType: string | null;
  entityId: string | null;
  outcome: 'SUCCESS' | 'DENIED' | 'FAILURE';
  createdAt: string;
}

export interface AuditLogsResponse {
  items: AuditLogEntry[];
}

/** The four states the API returns. `DONE`, not `SUCCEEDED`: the payload, the schema
constraint and this union are one vocabulary, and a monitor that translates states is
where a failure starts rendering as green. */
export type IngestionState = 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED';

export type IngestionStage = 'QUEUED' | 'FETCH' | 'EXTRACT' | 'CLEAN' | 'CHUNK' | 'EMBED' | 'PERSIST' | 'DONE';

/** `POST /admin/ingestion/*` and `GET /admin/ingestion/jobs[/:id]` — CONTENT_MANAGER. */
export interface IngestionJob {
  id: string;
  documentId: string | null;
  documentVersionId: string | null;
  sourceKind: 'url' | 'upload' | 'manifest' | 'manual';
  sourceLabel: string | null;
  state: IngestionState;
  stage: IngestionStage;
  error: string | null;
  /** Non-fatal findings (OCR needed, injection-like text, dropped pages). Surfaced, not swallowed. */
  warnings: string[];
  attempts: number;
  maxAttempts: number;
  /** Whether the worker may take this job again; false once the payload must be re-submitted. */
  retryable: boolean;
  needsResubmit: boolean;
  chunksProduced: number;
  requestedBy: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface IngestionJobsResponse {
  items: IngestionJob[];
  total: number;
  /** Failed jobs are counted and surfaced, never hidden (R8). */
  failed: number;
  queued: number;
}

/** The job the 202 response hands back, plus where to poll it. */
export interface IngestionAccepted {
  accepted: boolean;
  job: IngestionJob;
  poll: string;
}

export type ReviewState = 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED';

export interface InjectionFlag {
  rule: string;
  severity: string;
  excerpt: string;
}

/**
 * A row of `GET /admin/knowledge/chunks`. The list is a work queue, so it carries a
 * 400-character `preview`; the full `content` only exists on the detail endpoint.
 */
export interface KnowledgeChunkSummary {
  id: string;
  documentId: string;
  documentVersionId: string;
  ordinal: number;
  title: string;
  standardNo: string | null;
  section: string | null;
  headingPath: string | null;
  docType: string;
  language: 'en' | 'hi';
  sourceUrl: string | null;
  publishedDate: string | null;
  revisedDate: string | null;
  verificationStatus: VerificationStatus;
  reviewState: ReviewState;
  reviewedAt: string | null;
  verifiedAt: string | null;
  tokenCount: number;
  contentHash: string;
  embeddingModel: string | null;
  embeddedAt: string | null;
  hasEmbedding: boolean;
  embeddingDimensions: number;
  pages: number[];
  firstLine: number | null;
  lastLine: number | null;
  overlapTokens: number;
  injectionFlags: InjectionFlag[];
  preview: string;
}

export interface KnowledgeChunkDetail extends Omit<KnowledgeChunkSummary, 'preview'> {
  content: string;
}

export interface ChunkListResponse {
  items: KnowledgeChunkSummary[];
  total: number;
  pendingReview: number;
}

export interface ApproveVersionResponse {
  approved: number;
  kbVersion: number;
  meaning: string;
}

export interface RejectVersionResponse {
  rejected: number;
  kbVersion: number;
}

export interface KnowledgeDocumentSummary {
  id: string;
  title: string;
  standardNo: string | null;
  docType: string;
  language: 'en' | 'hi';
  accessLevel: 'open' | 'restricted';
  verificationStatus: VerificationStatus;
  publisher: string | null;
  approvedAt: string | null;
  latestVersionNo: number;
  createdAt: string;
  updatedAt: string;
  total: number;
  pending: number;
  approved: number;
  rejected: number;
  flagged: number;
}

export interface DocumentListResponse {
  items: KnowledgeDocumentSummary[];
  total: number;
  pendingReviewDocuments: number;
}

export interface DocumentSource {
  id: string;
  documentVersionId: string;
  sourceKind: string;
  url: string | null;
  publisher: string | null;
  retrievedAt: string;
  checksum: string | null;
  licenseNote: string | null;
  copyrightStatus: 'PUBLIC' | 'GOVERNMENT' | 'LICENSED' | 'RESTRICTED' | 'UNKNOWN';
  lastCheckedAt: string | null;
  lastCheckOutcome: 'UNCHANGED' | 'CHANGED' | 'LINK_ROT' | 'ERROR' | null;
  lastCheckDetail: string | null;
}

export interface DocumentDetail {
  id: string;
  title: string;
  standardNo: string | null;
  docType: string;
  language: 'en' | 'hi';
  accessLevel: 'open' | 'restricted';
  verificationStatus: VerificationStatus;
  publisher: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  versions: Array<{
    id: string;
    versionNo: number;
    contentHash: string;
    publishedDate: string | null;
    revisedDate: string | null;
    isCurrent: boolean;
    createdAt: string;
    chunks: number;
    pending: number;
    sources: DocumentSource[];
  }>;
  jobs: IngestionJob[];
}

export interface FreshnessResponse {
  items: Array<
    DocumentSource & {
      documentTitle: string;
      documentVerificationStatus: VerificationStatus;
      recheckable: boolean;
    }
  >;
  total: number;
  recheckable: number;
  changed: number;
  linkRot: number;
  neverChecked: number;
}

export interface FreshnessSweepResponse {
  checked: number;
  durationMs: number;
  results: Array<{ id: string; outcome: string; detail?: string | null }>;
  note: string;
}

export interface GapGroup {
  intent: string;
  topic: string | null;
  count: number;
  distinctQuestions: number;
  languages: Array<'en' | 'hi'>;
  firstSeenAt: string;
  lastSeenAt: string;
  examples: Array<{ queryText: string; language: 'en' | 'hi'; occurredAt: string }>;
}

export interface GapsResponse {
  items: GapGroup[];
  total: number;
  note: string;
}

export interface FeedbackListResponse {
  items: Array<{
    id: string;
    userId: string | null;
    messageId: string | null;
    conversationId: string | null;
    helpful: boolean | null;
    rating: number | null;
    issueType: 'WRONG_ANSWER' | 'MISSING_SOURCE' | 'STALE_SOURCE' | 'LANGUAGE' | 'OTHER' | null;
    comment: string | null;
    resolved: boolean;
    createdAt: string;
  }>;
  total: number;
  open: number;
  note: string;
}

export interface ManifestResponse {
  accepted: boolean;
  queued: IngestionJob[];
  rejected: Array<{ line: number; field?: string; reason: string }>;
  deferredRows: number;
  columns: string[];
}

/** Shared `…meta` fields on every submission route (docs/API.md). */
export interface IngestMeta {
  title: string;
  docType?: string;
  language?: 'en' | 'hi';
  standardNo?: string;
  publisher?: string;
  licenseNote?: string;
  copyrightStatus?: 'PUBLIC' | 'GOVERNMENT' | 'LICENSED' | 'RESTRICTED' | 'UNKNOWN';
  accessLevel?: 'open' | 'restricted';
  publishedDate?: string;
  revisedDate?: string;
  documentId?: string;
  overrideInjectionFlags?: boolean;
  force?: boolean;
}
