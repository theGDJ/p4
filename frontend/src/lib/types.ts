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

/** `GET /admin/ingestion/jobs` — CONTENT_MANAGER and above. */
export interface IngestionJob {
  id: string;
  documentId: string | null;
  sourceKind: string;
  state: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  stage: string;
  error: string | null;
  attempts: number;
  chunksProduced: number;
  requestedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IngestionJobsResponse {
  items: IngestionJob[];
  total: number;
  /** Failed jobs are counted and surfaced, never hidden (R8). */
  failed: number;
}
