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
  createdAt: Date;
}

/** Mirrors `knowledge_chunks` in V1__init.sql (embedding/tsv columns omitted here). */
export interface KnowledgeChunkRow {
  id: string;
  documentId: string;
  documentVersionId: string;
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
  ingestedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface IngestionJobRow {
  id: string;
  documentId: string | null;
  sourceKind: 'upload' | 'url' | 'manifest';
  state: 'QUEUED' | 'RUNNING' | 'FAILED' | 'DONE';
  stage: string | null;
  error: string | null;
  attempts: number;
  chunksProduced: number;
  requestedBy: string | null;
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
  knowledgeChunks: Table<KnowledgeChunkRow>;
  ingestionJobs: Table<IngestionJobRow>;
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
    knowledgeChunks: table(),
    ingestionJobs: table(),
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

export const knowledgeDocuments = {
  put: (s: Store, row: KnowledgeDocumentRow) => put(s.knowledgeDocuments, row),
  approved: (s: Store): KnowledgeDocumentRow[] =>
    [...s.knowledgeDocuments.rows.values()].filter(
      (d) => d.approvedAt !== null && d.verificationStatus !== 'SUPERSEDED',
    ),
};

export const knowledgeChunks = {
  put: (s: Store, row: KnowledgeChunkRow) => put(s.knowledgeChunks, row),
  /**
   * R7: only APPROVED chunks are retrievable, and SUPERSEDED versions never are.
   * The filter lives in the query so no caller can forget it.
   */
  retrievable: (s: Store): KnowledgeChunkRow[] =>
    [...s.knowledgeChunks.rows.values()].filter(
      (c) => c.reviewState === 'APPROVED' && c.verificationStatus !== 'SUPERSEDED',
    ),
  countRetrievable: (s: Store): number => knowledgeChunks.retrievable(s).length,
};

export const ingestionJobs = {
  put: (s: Store, row: IngestionJobRow) => put(s.ingestionJobs, row),
  list: (s: Store, limit = 100): IngestionJobRow[] =>
    [...s.ingestionJobs.rows.values()]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit),
};
