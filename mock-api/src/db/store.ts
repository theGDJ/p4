import type { EvidenceTier, Intent, Language, Persona, Role, VerificationStatus } from '../constants';

/**
 * In-memory persistence for the mock API.
 *
 * Table and column names deliberately mirror `backend/src/main/resources/db/migration/V1__init.sql`
 * so swapping this module for JPA repositories is mechanical. This store exists
 * only because the sandbox has no PostgreSQL (docs/ENVIRONMENT.md); it is NOT a
 * substitute for the real schema and holds nothing across restarts.
 *
 * Every user-owned read goes through a `userId`-scoped query helper — R9.
 */

export interface UserRow {
  id: string;
  email: string; // stored lowercased
  passwordHash: string;
  fullName: string;
  persona: Persona | null;
  language: Language;
  roles: Role[];
  emailVerified: boolean;
  failedLoginAttempts: number;
  lockedUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RefreshTokenRow {
  id: string;
  userId: string;
  familyId: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
  replacedByTokenId: string | null;
  userAgent: string | null;
  createdAt: Date;
}

export interface PasswordResetRow {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

export interface ConversationRow {
  id: string;
  userId: string;
  title: string;
  summary: string | null;
  language: Language;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

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

export interface MessageRow {
  id: string;
  conversationId: string;
  userId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  sourcesJson: SourceSnapshot[];
  evidenceTier: EvidenceTier;
  intent: Intent | null;
  language: Language;
  promptTokens: number;
  completionTokens: number;
  /** null when the deployment has not configured pricing (§9) — never a guess. */
  costUsd: number | null;
  model: string | null;
  cacheHit: boolean;
  retrievalMs: number | null;
  followUps: string[];
  error: string | null;
  createdAt: Date;
}

export interface AuditLogRow {
  id: string;
  actorUserId: string | null;
  actorRoles: Role[];
  action: string;
  entityType: string;
  entityId: string | null;
  outcome: 'SUCCESS' | 'DENIED' | 'FAILURE';
  ip: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface KnowledgeDocumentRow {
  id: string;
  title: string;
  standardNo: string | null;
  docType: string;
  language: Language;
  accessLevel: 'open' | 'restricted';
  verificationStatus: VerificationStatus;
  approvedAt: Date | null;
  /** Publisher as recorded by the ingesting human; never inferred (R2). */
  publisher: string | null;
  /** Highest `document_versions.version_no`; a re-ingest supersedes the previous one. */
  latestVersionNo: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Mirrors `document_versions`. Citations point here, so a re-ingest cannot rewrite past evidence (R2). */
export interface DocumentVersionRow {
  id: string;
  documentId: string;
  versionNo: number;
  /** SHA-256 of the normalised extracted text — the freshness diff (§6 #13). */
  contentHash: string;
  publishedDate: string | null;
  revisedDate: string | null;
  isCurrent: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Mirrors `document_sources` — provenance plus the checksum record the freshness monitor compares against. */
export interface DocumentSourceRow {
  id: string;
  documentVersionId: string;
  sourceKind: 'url' | 'file' | 'manual' | 'api';
  url: string | null;
  publisher: string | null;
  retrievedAt: Date;
  /** SHA-256 of the raw bytes fetched, for the freshness monitor. */
  checksum: string | null;
  licenseNote: string | null;
  /** R11: copyright status is recorded at ingestion time, not inferred later. */
  copyrightStatus: 'PUBLIC' | 'GOVERNMENT' | 'LICENSED' | 'RESTRICTED' | 'UNKNOWN';
  /** Freshness monitor state (§6 #13). Null until the first check. */
  lastCheckedAt: Date | null;
  lastCheckOutcome: 'UNCHANGED' | 'CHANGED' | 'LINK_ROT' | 'ERROR' | null;
  lastCheckDetail: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Mirrors `feedback` (§6 #15). Thumbs plus a reason; feeds the golden eval set. */
export interface FeedbackRow {
  id: string;
  userId: string | null;
  messageId: string | null;
  conversationId: string | null;
  helpful: boolean | null;
  rating: number | null;
  issueType: 'WRONG_ANSWER' | 'MISSING_SOURCE' | 'STALE_SOURCE' | 'LANGUAGE' | 'OTHER' | null;
  comment: string | null;
  resolved: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Mirrors `gap_queries` (§6 #14): the redacted question the KB could not answer. */
export interface GapQueryRow {
  id: string;
  userId: string | null;
  conversationId: string | null;
  queryText: string;
  language: Language;
  intent: Intent | null;
  occurredAt: Date;
  createdAt: Date;
  updatedAt: Date;
}


/** Mirrors `knowledge_chunks` in V1__init.sql. `tsv` is a generated column, so it has no field here. */
export interface KnowledgeChunkRow {
  id: string;
  documentId: string;
  documentVersionId: string;
  ordinal: number;
  title: string;
  standardNo: string | null;
  section: string | null;
  headingPath: string | null;
  docType: string;
  language: Language;
  sourceUrl: string | null;
  publishedDate: string | null;
  revisedDate: string | null;
  verificationStatus: VerificationStatus;
  verifiedBy: string | null;
  verifiedAt: string | null;
  /** APPROVED chunks are the only ones retrieval may return (R7). */
  reviewState: 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED';
  content: string;
  contentHash: string;
  tokenCount: number;
  embeddingModel: string | null;
  embeddedAt: Date | null;
  /**
   * In-memory stand-in for the `vector(1024)` column. Null when the chunk has not
   * been embedded yet — and a null embedding is exactly what `/health/ready`
   * reports as an ingestion gap instead of silently scoring it as zero overlap.
   */
  embedding: number[] | null;
  /** Page range, injection flags, source offsets. Never user-visible content. */
  metadata: Record<string, unknown>;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  ingestedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Mirrors `ingestion_jobs`. `state` uses the §5 vocabulary — QUEUED / RUNNING /
 * DONE / FAILED — and `stage` records how far it got, because "FAILED" alone is
 * not actionable and the whole point of the job monitor (feature #4) is that an
 * operator can see which step broke.
 */
export interface IngestionJobRow {
  id: string;
  documentId: string | null;
  documentVersionId: string | null;
  sourceKind: 'upload' | 'url' | 'manifest' | 'manual';
  /** URL or filename, for the monitor. Null for pasted text. */
  sourceLabel: string | null;
  state: 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED';
  stage: 'QUEUED' | 'FETCH' | 'EXTRACT' | 'CLEAN' | 'CHUNK' | 'EMBED' | 'PERSIST' | 'DONE' | null;
  error: string | null;
  /** Non-fatal findings (OCR needed, injection-like strings, page drops). Surfaced, not swallowed. */
  warnings: string[];
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date | null;
  chunksProduced: number;
  requestedBy: string | null;
  /**
   * The request, minus any pasted/uploaded payload: enough to re-run the job from
   * its URL without a client round-trip. `needsResubmit` says when that is not
   * possible and an operator must upload again.
   */
  spec: Record<string, unknown> | null;
  needsResubmit: boolean;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface Table<T extends { id: string }> {
  rows: Map<string, T>;
}

function table<T extends { id: string }>(): Table<T> {
  return { rows: new Map() };
}

export interface Store {
  users: Table<UserRow>;
  refreshTokens: Table<RefreshTokenRow>;
  passwordResets: Table<PasswordResetRow>;
  conversations: Table<ConversationRow>;
  messages: Table<MessageRow>;
  auditLogs: Table<AuditLogRow>;
  knowledgeDocuments: Table<KnowledgeDocumentRow>;
  documentVersions: Table<DocumentVersionRow>;
  documentSources: Table<DocumentSourceRow>;
  knowledgeChunks: Table<KnowledgeChunkRow>;
  ingestionJobs: Table<IngestionJobRow>;
  feedback: Table<FeedbackRow>;
  gapQueries: Table<GapQueryRow>;
  /** Bumped whenever approved knowledge changes; part of the semantic cache key (§9). */
  kbVersion: number;
}

export function createStore(): Store {
  return {
    users: table(),
    refreshTokens: table(),
    passwordResets: table(),
    conversations: table(),
    messages: table(),
    auditLogs: table(),
    knowledgeDocuments: table(),
    documentVersions: table(),
    documentSources: table(),
    knowledgeChunks: table(),
    ingestionJobs: table(),
    feedback: table(),
    gapQueries: table(),
    kbVersion: 0,
  };
}

/** Singleton for the running server; tests build their own via `createStore()`. */
let singleton: Store = createStore();
export function db(): Store {
  return singleton;
}
export function resetDb(): void {
  singleton = createStore();
}

function put<T extends { id: string }>(t: Table<T>, row: T): T {
  t.rows.set(row.id, row);
  return row;
}

/* ------------------------------------------------------------------ users */

export const users = {
  put: (s: Store, row: UserRow) => put(s.users, row),
  byId: (s: Store, id: string): UserRow | undefined => s.users.rows.get(id),
  byEmail: (s: Store, email: string): UserRow | undefined => {
    const needle = email.trim().toLowerCase();
    for (const u of s.users.rows.values()) if (u.email === needle) return u;
    return undefined;
  },
  all: (s: Store): UserRow[] => [...s.users.rows.values()],
  count: (s: Store): number => s.users.rows.size,
};

/* --------------------------------------------------------- refresh tokens */

export const refreshTokens = {
  put: (s: Store, row: RefreshTokenRow) => put(s.refreshTokens, row),
  byHash: (s: Store, tokenHash: string): RefreshTokenRow | undefined => {
    for (const t of s.refreshTokens.rows.values()) if (t.tokenHash === tokenHash) return t;
    return undefined;
  },
  byFamily: (s: Store, familyId: string): RefreshTokenRow[] =>
    [...s.refreshTokens.rows.values()].filter((t) => t.familyId === familyId),
  /** R9: a user's sessions are always queried by userId. */
  byUser: (s: Store, userId: string): RefreshTokenRow[] =>
    [...s.refreshTokens.rows.values()].filter((t) => t.userId === userId),
  revokeFamily: (s: Store, familyId: string, at = new Date()): number => {
    let n = 0;
    for (const t of s.refreshTokens.rows.values()) {
      if (t.familyId === familyId && t.revokedAt === null) {
        t.revokedAt = at;
        n += 1;
      }
    }
    return n;
  },
  revokeAllForUser: (s: Store, userId: string, at = new Date()): number => {
    let n = 0;
    for (const t of s.refreshTokens.rows.values()) {
      if (t.userId === userId && t.revokedAt === null) {
        t.revokedAt = at;
        n += 1;
      }
    }
    return n;
  },
};

/* ---------------------------------------------------------- conversations */

export const conversations = {
  put: (s: Store, row: ConversationRow) => put(s.conversations, row),
  /**
   * R9: the userId filter is part of the lookup, not a post-check. A conversation
   * belonging to someone else is indistinguishable from one that does not exist.
   */
  byIdForUser: (s: Store, id: string, userId: string): ConversationRow | undefined => {
    const row = s.conversations.rows.get(id);
    return row && row.userId === userId ? row : undefined;
  },
  listForUser: (s: Store, userId: string): ConversationRow[] =>
    [...s.conversations.rows.values()]
      .filter((c) => c.userId === userId && c.archivedAt === null)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()),
  remove: (s: Store, id: string, userId: string): boolean => {
    const row = conversations.byIdForUser(s, id, userId);
    if (!row) return false;
    s.conversations.rows.delete(id);
    return true;
  },
  countForUser: (s: Store, userId: string): number => conversations.listForUser(s, userId).length,
};

/* --------------------------------------------------------------- messages */

export const messages = {
  put: (s: Store, row: MessageRow) => put(s.messages, row),
  listForConversation: (s: Store, conversationId: string, userId: string): MessageRow[] =>
    [...s.messages.rows.values()]
      .filter((m) => m.conversationId === conversationId && m.userId === userId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
};

/* ----------------------------------------------------------- password reset */

export const passwordResets = {
  put: (s: Store, row: PasswordResetRow) => put(s.passwordResets, row),
  byHash: (s: Store, tokenHash: string): PasswordResetRow | undefined => {
    for (const r of s.passwordResets.rows.values()) if (r.tokenHash === tokenHash) return r;
    return undefined;
  },
  invalidateForUser: (s: Store, userId: string): void => {
    for (const r of s.passwordResets.rows.values()) {
      if (r.userId === userId && r.usedAt === null) r.usedAt = new Date();
    }
  },
};

/* ------------------------------------------------------------- audit logs */

export const auditLogs = {
  put: (s: Store, row: AuditLogRow) => put(s.auditLogs, row),
  list: (s: Store, limit = 200): AuditLogRow[] =>
    [...s.auditLogs.rows.values()]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit),
};

/* ------------------------------------------------------- knowledge / jobs */

/**
 * Approving, rejecting or superseding knowledge changes what retrieval may
 * return, so every mutation of approved content goes through `bumpKbVersion`:
 * the semantic answer cache is keyed on it (§9) and the UI badge reads it.
 */
export function bumpKbVersion(s: Store): number {
  s.kbVersion += 1;
  return s.kbVersion;
}

export const knowledgeDocuments = {
  put: (s: Store, row: KnowledgeDocumentRow) => put(s.knowledgeDocuments, row),
  byId: (s: Store, id: string): KnowledgeDocumentRow | undefined => s.knowledgeDocuments.rows.get(id),
  byStandardNo: (s: Store, standardNo: string): KnowledgeDocumentRow | undefined => {
    const needle = standardNo.trim().replace(/\s+/g, ' ').toUpperCase();
    for (const d of s.knowledgeDocuments.rows.values()) {
      if (d.standardNo && d.standardNo.replace(/\s+/g, ' ').toUpperCase() === needle) return d;
    }
    return undefined;
  },
  list: (s: Store, limit = 200): KnowledgeDocumentRow[] =>
    [...s.knowledgeDocuments.rows.values()]
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, limit),
  approved: (s: Store): KnowledgeDocumentRow[] =>
    [...s.knowledgeDocuments.rows.values()].filter(
      (d) => d.approvedAt !== null && d.verificationStatus !== 'SUPERSEDED',
    ),
  count: (s: Store): number => s.knowledgeDocuments.rows.size,
};

export const documentVersions = {
  put: (s: Store, row: DocumentVersionRow) => put(s.documentVersions, row),
  byId: (s: Store, id: string): DocumentVersionRow | undefined => s.documentVersions.rows.get(id),
  forDocument: (s: Store, documentId: string): DocumentVersionRow[] =>
    [...s.documentVersions.rows.values()]
      .filter((v) => v.documentId === documentId)
      .sort((a, b) => b.versionNo - a.versionNo),
  currentFor: (s: Store, documentId: string): DocumentVersionRow | undefined =>
    [...s.documentVersions.rows.values()].find((v) => v.documentId === documentId && v.isCurrent),
  /** Clears `is_current` on the previous version; the new one takes its place. */
  supersedeCurrent: (s: Store, documentId: string, at = new Date()): number => {
    let n = 0;
    for (const v of s.documentVersions.rows.values()) {
      if (v.documentId === documentId && v.isCurrent) {
        v.isCurrent = false;
        v.updatedAt = at;
        n += 1;
      }
    }
    return n;
  },
  count: (s: Store): number => s.documentVersions.rows.size,
};

export const documentSources = {
  put: (s: Store, row: DocumentSourceRow) => put(s.documentSources, row),
  byId: (s: Store, id: string): DocumentSourceRow | undefined => s.documentSources.rows.get(id),
  forVersion: (s: Store, versionId: string): DocumentSourceRow[] =>
    [...s.documentSources.rows.values()].filter((r) => r.documentVersionId === versionId),
  /** The freshness monitor (§6 #13) can only re-check something it fetched by URL. */
  checkable: (s: Store): DocumentSourceRow[] =>
    [...s.documentSources.rows.values()].filter((r) => r.sourceKind === 'url' && !!r.url),
};

export const knowledgeChunks = {
  put: (s: Store, row: KnowledgeChunkRow) => put(s.knowledgeChunks, row),
  byId: (s: Store, id: string): KnowledgeChunkRow | undefined => s.knowledgeChunks.rows.get(id),
  all: (s: Store): KnowledgeChunkRow[] => [...s.knowledgeChunks.rows.values()],
  forVersion: (s: Store, versionId: string): KnowledgeChunkRow[] =>
    [...s.knowledgeChunks.rows.values()]
      .filter((c) => c.documentVersionId === versionId)
      .sort((a, b) => a.ordinal - b.ordinal),
  forDocument: (s: Store, documentId: string): KnowledgeChunkRow[] =>
    [...s.knowledgeChunks.rows.values()]
      .filter((c) => c.documentId === documentId)
      .sort((a, b) => a.ordinal - b.ordinal),
  countByState: (s: Store, state: KnowledgeChunkRow['reviewState']): number =>
    [...s.knowledgeChunks.rows.values()].filter((c) => c.reviewState === state).length,
  /**
   * R7: only APPROVED chunks are retrievable, and SUPERSEDED versions never are.
   * The filter lives in the query so no caller can forget it.
   */
  retrievable: (s: Store): KnowledgeChunkRow[] =>
    [...s.knowledgeChunks.rows.values()].filter(
      (c) => c.reviewState === 'APPROVED' && c.verificationStatus !== 'SUPERSEDED',
    ),
  countRetrievable: (s: Store): number => knowledgeChunks.retrievable(s).length,
  /**
   * Version-level review: approving a version makes its chunks searchable and
   * marks every older version's chunks SUPERSEDED, so a stale clause cannot be
   * returned next to a fresh one (§5 "New version supersedes old; old retained").
   */
  approveVersion: (s: Store, versionId: string, reviewerId: string, at = new Date()): number => {
    const version = documentVersions.byId(s, versionId);
    if (!version) return 0;
    let n = 0;
    for (const c of s.knowledgeChunks.rows.values()) {
      if (c.documentVersionId === versionId) {
        c.reviewState = 'APPROVED';
        if (c.verificationStatus !== 'OUTDATED') c.verificationStatus = 'VERIFIED';
        c.reviewedBy = reviewerId;
        c.reviewedAt = at;
        c.verifiedBy = c.verifiedBy ?? reviewerId;
        c.verifiedAt = c.verifiedAt ?? at.toISOString();
        c.updatedAt = at;
        n += 1;
      } else if (c.documentId === version.documentId) {
        // Older versions stay in the table (auditability) but leave the index.
        c.reviewState = 'REJECTED';
        c.verificationStatus = 'SUPERSEDED';
        c.updatedAt = at;
      }
    }
    if (n > 0) bumpKbVersion(s);
    return n;
  },
  reject: (s: Store, chunkId: string, reviewerId: string, at = new Date()): boolean => {
    const chunk = knowledgeChunks.byId(s, chunkId);
    if (!chunk) return false;
    chunk.reviewState = 'REJECTED';
    chunk.verificationStatus = 'REJECTED' as KnowledgeChunkRow['verificationStatus'];
    chunk.reviewedBy = reviewerId;
    chunk.reviewedAt = at;
    chunk.updatedAt = at;
    // Removing text from the index has to invalidate the answers that were built
    // from it, or a rejected chunk keeps being quoted from the cache (§9).
    bumpKbVersion(s);
    return true;
  },
};

export const ingestionJobs = {
  put: (s: Store, row: IngestionJobRow) => put(s.ingestionJobs, row),
  byId: (s: Store, id: string): IngestionJobRow | undefined => s.ingestionJobs.rows.get(id),
  forDocument: (s: Store, documentId: string): IngestionJobRow[] =>
    [...s.ingestionJobs.rows.values()]
      .filter((j) => j.documentId === documentId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
  list: (s: Store, limit = 100): IngestionJobRow[] =>
    [...s.ingestionJobs.rows.values()]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit),
  /** §5 "async, retryable job": only a FAILED job with attempts left may run again. */
  isRetryable: (job: IngestionJobRow, now = Date.now()): boolean =>
    job.state === 'FAILED' &&
    job.attempts < job.maxAttempts &&
    (job.nextAttemptAt === null || job.nextAttemptAt.getTime() <= now),
};

export const feedback = {
  put: (s: Store, row: FeedbackRow) => put(s.feedback, row),
  byId: (s: Store, id: string): FeedbackRow | undefined => s.feedback.rows.get(id),
  forMessage: (s: Store, messageId: string): FeedbackRow[] =>
    [...s.feedback.rows.values()].filter((f) => f.messageId === messageId),
  listForAdmin: (s: Store, limit = 200): FeedbackRow[] =>
    [...s.feedback.rows.values()]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit),
  countOpen: (s: Store): number => [...s.feedback.rows.values()].filter((f) => !f.resolved).length,
};

export const gapQueries = {
  put: (s: Store, row: GapQueryRow) => put(s.gapQueries, row),
  list: (s: Store, limit = 500): GapQueryRow[] =>
    [...s.gapQueries.rows.values()]
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
      .slice(0, limit),
  count: (s: Store): number => s.gapQueries.rows.size,
};
