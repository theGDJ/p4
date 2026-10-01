import { type RequestHandler, Router, type Request } from 'express';
import { z } from 'zod';
import { config } from '../../config';
import {
  bumpKbVersion,
  documentSources,
  feedback,
  documentVersions,
  gapQueries,
  ingestionJobs,
  knowledgeChunks,
  knowledgeDocuments,
  type DocumentSourceRow,
  type IngestionJobRow,
  type KnowledgeChunkRow,
  type Store,
} from '../../db/store';
import { AUDIT_ACTIONS, recordAudit } from '../../lib/audit';
import { notFound, payloadTooLarge, rateLimited } from '../../lib/errors';
import { clientIp } from '../../lib/rateLimit';
import { authenticate, requireRole, type AuthenticatedRequest } from '../../security/middleware';
import {
  ingestManifestSchema,
  ingestTextSchema,
  ingestUploadSchema,
  ingestUrlSchema,
  listChunksQuery,
  listDocumentsQuery,
  reviewChunkSchema,
  validateBody,
  validateParams,
  validateQuery,
} from '../../lib/validate';
import { parseManifest } from './manifest';
import { approveVersion, newJob, rejectVersion, retryJob, runFreshnessSweep, startJob, type IngestionSpec } from './pipeline';

/**
 * Knowledge administration (§6 feature #4) and the monitors built on it
 * (§6 #13 freshness, #14 knowledge gaps).
 *
 * Mounted at the API base so one module owns both surfaces it implements:
 * `/admin/ingestion/*` (queueing, jobs) and `/admin/knowledge/*` (review, gaps).
 * Roles are enforced per route,
 * server-side (§4): a CONTENT_MANAGER may ingest and approve, only an ADMIN reads
 * the audit trail. `GET /admin/audit-logs` stays in `meta/routes.ts`.
 *
 * Two properties the routes must not lose:
 *
 * - Ingestion is **asynchronous**: every POST here queues a job and answers 202. A
 *   25 MB PDF cannot be extracted inside a request, and pretending otherwise would
 *   make the client believe the document is searchable when it is not.
 * - Nothing becomes searchable through this router without an explicit approve,
 *   which is audited (R7).
 */

const idParam = z.object({ id: z.string().min(1).max(64) });
const versionIdParam = z.object({ id: z.string().min(1).max(64), versionId: z.string().min(1).max(64) });

function param(req: Request, name: 'id' | 'versionId'): string {
  const raw = (req.params as Record<string, unknown>)[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const id = typeof value === 'string' ? value.trim() : '';
  if (id.length === 0 || id.length > 64) throw notFound('Resource');
  return id;
}

/* ------------------------------------------------- queue fairness (per user) */

/**
 * A cheap in-process bucket so a script cannot turn the ingest endpoint into an
 * outbound-flood generator against bis.gov.in. Not a substitute for the global
 * limiter, and not durable: it exists to protect a third party, not this server.
 */
const buckets = new Map<string, { tokens: number; updatedAt: number }>();
const INGEST_BURST = 12;
const REFILL_PER_SECOND = 0.2; // ~12 per minute

/**
 * Test hook only. The buckets are process state on purpose (one limiter per process is
 * what protects a third-party site), but that means a suite that fired 20 submissions
 * would leave the next test in the same process holding an empty bucket, which is how
 * rate-limit tests produce flaky 429s in unrelated files.
 */
export function resetIngestThrottleForTests(): void {
  buckets.clear();
}

function takeIngestToken(key: string): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  if (buckets.size > 1_000) {
    // No unbounded growth: evict anything idle for over an hour.
    for (const [k, v] of buckets) if (now - v.updatedAt > 3_600_000) buckets.delete(k);
  }
  const bucket = buckets.get(key) ?? { tokens: INGEST_BURST, updatedAt: now };
  const refilled = Math.min(INGEST_BURST, bucket.tokens + ((now - bucket.updatedAt) / 1000) * REFILL_PER_SECOND);
  if (refilled < 1) {
    buckets.set(key, { tokens: refilled, updatedAt: now });
    // Computed from the bucket rather than guessed, so the header the client is told
    // matches when the token actually lands.
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - refilled) / REFILL_PER_SECOND)) };
  }
  buckets.set(key, { tokens: refilled - 1, updatedAt: now });
  return { allowed: true, retryAfterSeconds: 0 };
}

/* ------------------------------------------------------------ serialisers */

function publicJob(job: IngestionJobRow) {
  return {
    id: job.id,
    documentId: job.documentId,
    documentVersionId: job.documentVersionId,
    sourceKind: job.sourceKind,
    sourceLabel: job.sourceLabel,
    state: job.state,
    stage: job.stage,
    error: job.error,
    warnings: job.warnings,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    retryable: ingestionJobs.isRetryable(job),
    needsResubmit: job.needsResubmit,
    chunksProduced: job.chunksProduced,
    requestedBy: job.requestedBy,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

function injectionFlags(chunk: KnowledgeChunkRow): Array<{ rule: string; severity: string; excerpt: string }> {
  const raw = (chunk.metadata as { injectionFlags?: unknown }).injectionFlags;
  return Array.isArray(raw) ? (raw as Array<{ rule: string; severity: string; excerpt: string }>) : [];
}

function publicChunk(chunk: KnowledgeChunkRow, opts: { full?: boolean } = {}) {
  const metadata = chunk.metadata as {
    pages?: number[];
    firstLine?: number;
    lastLine?: number;
    overlapTokens?: number;
  };
  return {
    id: chunk.id,
    documentId: chunk.documentId,
    documentVersionId: chunk.documentVersionId,
    ordinal: chunk.ordinal,
    title: chunk.title,
    standardNo: chunk.standardNo,
    section: chunk.section,
    headingPath: chunk.headingPath,
    docType: chunk.docType,
    language: chunk.language,
    sourceUrl: chunk.sourceUrl,
    publishedDate: chunk.publishedDate,
    revisedDate: chunk.revisedDate,
    verificationStatus: chunk.verificationStatus,
    reviewState: chunk.reviewState,
    reviewedAt: chunk.reviewedAt?.toISOString() ?? null,
    verifiedAt: chunk.verifiedAt,
    tokenCount: chunk.tokenCount,
    contentHash: chunk.contentHash,
    embeddingModel: chunk.embeddingModel,
    embeddedAt: chunk.embeddedAt?.toISOString() ?? null,
    // The vector itself never leaves the server: 1024 floats in a JSON payload
    // would be a 20 KB response for a field no human can read.
    hasEmbedding: chunk.embedding !== null,
    embeddingDimensions: chunk.embedding?.length ?? 0,
    pages: metadata.pages ?? [],
    firstLine: metadata.firstLine ?? null,
    lastLine: metadata.lastLine ?? null,
    overlapTokens: metadata.overlapTokens ?? 0,
    injectionFlags: injectionFlags(chunk),
    ...(opts.full ? { content: chunk.content } : { preview: chunk.content.slice(0, 400) }),
  };
}

function publicSource(source: DocumentSourceRow) {
  return {
    id: source.id,
    documentVersionId: source.documentVersionId,
    sourceKind: source.sourceKind,
    url: source.url,
    publisher: source.publisher,
    retrievedAt: source.retrievedAt.toISOString(),
    checksum: source.checksum,
    licenseNote: source.licenseNote,
    copyrightStatus: source.copyrightStatus,
    lastCheckedAt: source.lastCheckedAt?.toISOString() ?? null,
    lastCheckOutcome: source.lastCheckOutcome,
    lastCheckDetail: source.lastCheckDetail,
  };
}

/* ------------------------------------------------------------------ router */

export function ingestionRouter(store: Store): Router {
  // Every path below is absolute from the API base — see the header comment.
  const router = Router();
  /**
   * Applied *after* `authenticate` and `requireRole`, on every POST below.
   *
   * The order matters twice over. A limiter that runs before authentication spends
   * anonymous callers' tokens against a shared key and writes an audit row with no
   * actor — a denied action nobody can attribute is not an audit trail. And a
   * request that is going to be refused anyway should not consume the budget of the
   * account that would have made it.
   */
  const throttle: RequestHandler = (req, _res, next) => {
    const r = req as AuthenticatedRequest;
    if (req.method !== 'POST') {
      next();
      return;
    }
    const key = `${r.user?.id ?? clientIp(req)}|ingest`;
    const token = takeIngestToken(key);
    if (token.allowed) {
      next();
      return;
    }
    recordAudit(store, {
      actorUserId: r.user?.id ?? null,
      actorRoles: r.user?.roles ?? [],
      action: AUDIT_ACTIONS.KNOWLEDGE_INGEST_THROTTLED,
      entityType: 'ingestion_job',
      outcome: 'DENIED',
      ip: clientIp(req),
      metadata: { retryAfterSeconds: token.retryAfterSeconds },
    });
    // 429 with Retry-After, not 503: this is a rate limit, and a client (or an
    // operator reading a dashboard) has to be able to tell "back off" from
    // "the server is broken". docs/API.md reserves 429 for exactly this.
    next(rateLimited(token.retryAfterSeconds));
  };

  const contentManager = [authenticate(store), requireRole(store, 'CONTENT_MANAGER'), throttle];


  /* ------------------------------------------------------------ queueing */

  function queue(req: AuthenticatedRequest, spec: IngestionSpec): { jobId: string; job: IngestionJobRow } {
    const job = newJob(store, spec);
    startJob(store, job.id, spec);
    recordAudit(store, {
      actorUserId: req.user!.id,
      actorRoles: req.user!.roles,
      action: AUDIT_ACTIONS.KNOWLEDGE_INGEST_REQUESTED,
      entityType: 'ingestion_job',
      entityId: job.id,
      ip: clientIp(req),
      metadata: { kind: spec.kind, docType: spec.docType, restricted: spec.accessLevel === 'restricted' },
    });
    return { jobId: job.id, job };
  }

  router.post('/admin/ingestion/url', ...contentManager, validateBody(ingestUrlSchema), (req, res) => {
    const r = req as AuthenticatedRequest;
    const body = req.body as z.infer<typeof ingestUrlSchema>;
    const { job } = queue(r, {
      kind: 'url',
      url: body.url,
      title: body.title,
      docType: body.docType,
      language: body.language,
      standardNo: body.standardNo ?? null,
      publisher: body.publisher ?? null,
      licenseNote: body.licenseNote ?? null,
      copyrightStatus: body.copyrightStatus,
      accessLevel: body.accessLevel,
      publishedDate: body.publishedDate,
      revisedDate: body.revisedDate,
      documentId: body.documentId ?? null,
      overrideInjectionFlags: body.overrideInjectionFlags,
      force: body.force,
      requestedBy: r.user!.id,
    });
    res.status(202).json({ accepted: true, job: publicJob(job), poll: `${config().API_BASE_PATH}/admin/ingestion/jobs/${job.id}` });
  });

  router.post('/admin/ingestion/text', ...contentManager, validateBody(ingestTextSchema), (req, res) => {
    const r = req as AuthenticatedRequest;
    const body = req.body as z.infer<typeof ingestTextSchema>;
    const { job } = queue(r, {
      kind: 'manual',
      text: body.content,
      title: body.title,
      docType: body.docType,
      language: body.language,
      standardNo: body.standardNo ?? null,
      publisher: body.publisher ?? null,
      licenseNote: body.licenseNote ?? null,
      copyrightStatus: body.copyrightStatus,
      accessLevel: body.accessLevel,
      publishedDate: body.publishedDate,
      revisedDate: body.revisedDate,
      documentId: body.documentId ?? null,
      overrideInjectionFlags: body.overrideInjectionFlags,
      force: body.force,
      requestedBy: r.user!.id,
    });
    res.status(202).json({ accepted: true, job: publicJob(job), poll: `${config().API_BASE_PATH}/admin/ingestion/jobs/${job.id}` });
  });

  /**
   * Uploads arrive as base64 inside JSON rather than multipart: the API stays one
   * shape for both stacks (no per-stack multipart parsing differences), and the
   * magic-byte and extension checks in `pipeline.ts` still apply.
   */
  router.post('/admin/ingestion/upload', ...contentManager, validateBody(ingestUploadSchema), (req, res) => {
    const r = req as AuthenticatedRequest;
    const body = req.body as z.infer<typeof ingestUploadSchema>;
    const decodedBytes = Math.floor((body.contentBase64.length * 3) / 4);
    if (decodedBytes > config().INGEST_MAX_BYTES) {
      throw payloadTooLarge(
        `That file is about ${Math.round(decodedBytes / 1_000_000)} MB; the ingestion limit is ${Math.round(config().INGEST_MAX_BYTES / 1_000_000)} MB.`,
      );
    }
    const { job } = queue(r, {
      kind: 'upload',
      filename: body.filename,
      contentBase64: body.contentBase64,
      title: body.title,
      docType: body.docType,
      language: body.language,
      standardNo: body.standardNo ?? null,
      publisher: body.publisher ?? null,
      licenseNote: body.licenseNote ?? null,
      copyrightStatus: body.copyrightStatus,
      accessLevel: body.accessLevel,
      publishedDate: body.publishedDate,
      revisedDate: body.revisedDate,
      documentId: body.documentId ?? null,
      overrideInjectionFlags: body.overrideInjectionFlags,
      force: body.force,
      requestedBy: r.user!.id,
    });
    res.status(202).json({ accepted: true, job: publicJob(job), poll: `${config().API_BASE_PATH}/admin/ingestion/jobs/${job.id}` });
  });

  /**
   * The P0 manifest, pasted or uploaded as CSV. Rows are validated before anything
   * is queued, and a rejected row is reported with its line number rather than
   * defaulted (R10).
   */
  router.post('/admin/ingestion/manifest', ...contentManager, validateBody(ingestManifestSchema), (req, res) => {
    const r = req as AuthenticatedRequest;
    const body = req.body as z.infer<typeof ingestManifestSchema>;
    const parsed = parseManifest(body.csv);
    const queued: IngestionJobRow[] = [];

    for (const spec of parsed.specs) {
      const { job } = queue(r, {
        ...spec,
        requestedBy: r.user!.id,
        autoApprove: body.honorApprovedStatus ? spec.autoApprove : false,
      });
      queued.push(job);
    }

    recordAudit(store, {
      actorUserId: r.user!.id,
      actorRoles: r.user!.roles,
      action: AUDIT_ACTIONS.KNOWLEDGE_INGEST_REQUESTED,
      entityType: 'manifest',
      outcome: parsed.specs.length === 0 ? 'FAILURE' : 'SUCCESS',
      ip: clientIp(req),
      metadata: { accepted: parsed.specs.length, rejected: parsed.rejected.length, deferred: parsed.deferred },
    });

    res.status(202).json({
      accepted: true,
      queued: queued.map(publicJob),
      rejected: parsed.rejected,
      // Rows the manifest itself does not mark approved: queued as jobs but left
      // PENDING_REVIEW, so a human is the one who makes them searchable (R7).
      deferredRows: parsed.deferred,
      columns: parsed.columns,
    });
  });

  /* --------------------------------------------------------------- jobs */

  /**
   * The published P1 list endpoint, kept at its original path and extended with the
   * fields the job monitor needs. `failed` stays in the payload because a monitor
   * that hides failures is worse than no monitor (R8).
   */
  router.get('/admin/ingestion/jobs', ...contentManager, (_req, res) => {
    const jobs = ingestionJobs.list(store, 200);
    res.json({
      items: jobs.map(publicJob),
      total: jobs.length,
      failed: jobs.filter((j) => j.state === 'FAILED').length,
      queued: jobs.filter((j) => j.state === 'QUEUED').length,
    });
  });

  router.get('/admin/ingestion/jobs/:id', ...contentManager, validateParams(idParam), (req, res) => {
    const job = ingestionJobs.byId(store, param(req, 'id'));
    if (!job) throw notFound('Ingestion job');
    res.json(publicJob(job));
  });

  router.post('/admin/ingestion/jobs/:id/retry', ...contentManager, validateParams(idParam), async (req, res) => {
    const r = req as AuthenticatedRequest;
    const job = ingestionJobs.byId(store, param(req, 'id'));
    if (!job) throw notFound('Ingestion job');
    const result = await retryJob(store, job.id);
    recordAudit(store, {
      actorUserId: r.user!.id,
      actorRoles: r.user!.roles,
      action: AUDIT_ACTIONS.KNOWLEDGE_JOB_RETRY,
      entityType: 'ingestion_job',
      entityId: job.id,
      outcome: result.job?.state === 'DONE' ? 'SUCCESS' : 'FAILURE',
      ip: clientIp(req),
      metadata: { message: result.message },
    });
    res.status(result.job?.state === 'DONE' ? 200 : 409).json({
      message: result.message,
      job: result.job ? publicJob(result.job) : null,
    });
  });

  /* ---------------------------------------------------------- documents */

  router.get('/admin/knowledge/documents', ...contentManager, validateQuery(listDocumentsQuery), (req, res) => {
    const q = (req as Request & { validatedQuery?: z.infer<typeof listDocumentsQuery> }).validatedQuery!;
    const all = knowledgeDocuments.list(store, 1000);
    const withCounts = all.map((d) => {
      const chunks = knowledgeChunks.forDocument(store, d.id);
      return {
        document: d,
        total: chunks.length,
        pending: chunks.filter((c) => c.reviewState === 'PENDING_REVIEW').length,
        approved: chunks.filter((c) => c.reviewState === 'APPROVED').length,
        rejected: chunks.filter((c) => c.reviewState === 'REJECTED').length,
        flagged: chunks.filter((c) => injectionFlags(c).length > 0).length,
      };
    });
    const filtered =
      q.reviewState === 'ALL'
        ? withCounts
        : withCounts.filter((row) => (q.reviewState === 'PENDING_REVIEW' ? row.pending > 0 : q.reviewState === 'APPROVED' ? row.approved > 0 : row.rejected > 0));

    res.json({
      items: filtered.slice(q.offset, q.offset + q.limit).map(({ document, ...counts }) => ({
        id: document.id,
        title: document.title,
        standardNo: document.standardNo,
        docType: document.docType,
        language: document.language,
        accessLevel: document.accessLevel,
        verificationStatus: document.verificationStatus,
        publisher: document.publisher,
        approvedAt: document.approvedAt?.toISOString() ?? null,
        latestVersionNo: document.latestVersionNo,
        createdAt: document.createdAt.toISOString(),
        updatedAt: document.updatedAt.toISOString(),
        ...counts,
      })),
      total: filtered.length,
      pendingReviewDocuments: withCounts.filter((row) => row.pending > 0).length,
    });
  });

  router.get('/admin/knowledge/documents/:id', ...contentManager, validateParams(idParam), (req, res) => {
    const document = knowledgeDocuments.byId(store, param(req, 'id'));
    if (!document) throw notFound('Document');
    const versions = documentVersions.forDocument(store, document.id);
    res.json({
      id: document.id,
      title: document.title,
      standardNo: document.standardNo,
      docType: document.docType,
      language: document.language,
      accessLevel: document.accessLevel,
      verificationStatus: document.verificationStatus,
      publisher: document.publisher,
      approvedAt: document.approvedAt?.toISOString() ?? null,
      createdAt: document.createdAt.toISOString(),
      updatedAt: document.updatedAt.toISOString(),
      versions: versions.map((v) => ({
        id: v.id,
        versionNo: v.versionNo,
        contentHash: v.contentHash,
        publishedDate: v.publishedDate,
        revisedDate: v.revisedDate,
        isCurrent: v.isCurrent,
        createdAt: v.createdAt.toISOString(),
        chunks: knowledgeChunks.forVersion(store, v.id).length,
        pending: knowledgeChunks.forVersion(store, v.id).filter((c) => c.reviewState === 'PENDING_REVIEW').length,
        sources: documentSources.forVersion(store, v.id).map(publicSource),
      })),
      jobs: ingestionJobs.forDocument(store, document.id).slice(0, 20).map(publicJob),
    });
  });

  /* ------------------------------------------------------------ chunks */

  router.get('/admin/knowledge/chunks', ...contentManager, validateQuery(listChunksQuery), (req, res) => {
    const q = (req as Request & { validatedQuery?: z.infer<typeof listChunksQuery> }).validatedQuery!;
    let rows: KnowledgeChunkRow[] = [];
    if (q.versionId) {
      const version = documentVersions.byId(store, q.versionId);
      if (!version) throw notFound('Document version');
      rows = knowledgeChunks.forVersion(store, version.id);
    } else if (q.documentId) {
      rows = knowledgeChunks.forDocument(store, q.documentId);
    } else {
      rows = knowledgeChunks.all(store).sort(
        (a, b) => b.ingestedAt.getTime() - a.ingestedAt.getTime() || a.ordinal - b.ordinal,
      );
    }
    const filtered = q.reviewState === 'ALL' ? rows : rows.filter((c) => c.reviewState === q.reviewState);
    res.json({
      items: filtered.slice(q.offset, q.offset + q.limit).map((c) => publicChunk(c)),
      total: filtered.length,
      pendingReview: rows.filter((c) => c.reviewState === 'PENDING_REVIEW').length,
    });
  });

  /** The chunk inspector (§6 #4): full text, provenance, embedding state, flags. */
  router.get('/admin/knowledge/chunks/:id', ...contentManager, validateParams(idParam), (req, res) => {
    const chunk = knowledgeChunks.byId(store, param(req, 'id'));
    if (!chunk) throw notFound('Chunk');
    res.json(publicChunk(chunk, { full: true }));
  });

  router.post('/admin/knowledge/chunks/:id/approve', ...contentManager, validateParams(idParam), validateBody(reviewChunkSchema), (req, res) => {
    const r = req as AuthenticatedRequest;
    const chunk = knowledgeChunks.byId(store, param(req, 'id'));
    if (!chunk) throw notFound('Chunk');
    const version = documentVersions.byId(store, chunk.documentVersionId);
    if (version && !version.isCurrent) {
      // Approving a stale version's chunk would make superseded text retrievable.
      res.status(409).json({
        error: {
          code: 'CONFLICT',
          message: 'This chunk belongs to a superseded version. Approve the current version instead, or re-ingest.',
          traceRef: r.traceRef,
        },
      });
      return;
    }
    const at = new Date();
    chunk.reviewState = 'APPROVED';
    chunk.verificationStatus = 'VERIFIED';
    chunk.reviewedBy = r.user!.id;
    chunk.reviewedAt = at;
    chunk.verifiedBy = r.user!.id;
    chunk.verifiedAt = at.toISOString();
    chunk.updatedAt = at;
    knowledgeChunks.put(store, chunk);
    bumpKbVersion(store); // cached answers were computed without this evidence (§9)
    recordAudit(store, {
      actorUserId: r.user!.id,
      actorRoles: r.user!.roles,
      action: AUDIT_ACTIONS.KNOWLEDGE_CHUNK_APPROVED,
      entityType: 'knowledge_chunk',
      entityId: chunk.id,
      ip: clientIp(req),
      metadata: { note: req.body.note ?? null, injectionFlags: injectionFlags(chunk).length },
    });
    res.json(publicChunk(chunk));
  });

  router.post('/admin/knowledge/chunks/:id/reject', ...contentManager, validateParams(idParam), validateBody(reviewChunkSchema), (req, res) => {
    const r = req as AuthenticatedRequest;
    const chunk = knowledgeChunks.byId(store, param(req, 'id'));
    if (!chunk) throw notFound('Chunk');
    knowledgeChunks.reject(store, chunk.id, r.user!.id);
    recordAudit(store, {
      actorUserId: r.user!.id,
      actorRoles: r.user!.roles,
      action: AUDIT_ACTIONS.KNOWLEDGE_CHUNK_REJECTED,
      entityType: 'knowledge_chunk',
      entityId: chunk.id,
      ip: clientIp(req),
      metadata: { note: req.body.note ?? null },
    });
    res.json(publicChunk(chunk));
  });

  router.post(
    '/admin/knowledge/documents/:id/versions/:versionId/approve',
    ...contentManager,
    validateParams(versionIdParam),
    validateBody(reviewChunkSchema),
    (req, res) => {
      const r = req as AuthenticatedRequest;
      const versionId = param(req, 'versionId');
      const version = documentVersions.byId(store, versionId);
      if (!version || version.documentId !== param(req, 'id')) throw notFound('Document version');
      const approved = approveVersion(store, versionId, r.user!.id);
      recordAudit(store, {
        actorUserId: r.user!.id,
        actorRoles: r.user!.roles,
        action: AUDIT_ACTIONS.KNOWLEDGE_VERSION_APPROVED,
        entityType: 'document_version',
        entityId: versionId,
        ip: clientIp(req),
        metadata: { chunks: approved, note: req.body.note ?? null },
      });
      res.json({
        approved,
        kbVersion: store.kbVersion,
        // R5: the approval makes text *searchable*, it does not make a standard
        // authoritative. The badge in the UI reads this, not a guess.
        meaning: `${approved} chunk(s) are now searchable. Approval records who reviewed the text; it does not certify the standard.`,
      });
    },
  );

  router.post(
    '/admin/knowledge/documents/:id/versions/:versionId/reject',
    ...contentManager,
    validateParams(versionIdParam),
    validateBody(reviewChunkSchema),
    (req, res) => {
      const r = req as AuthenticatedRequest;
      const versionId = param(req, 'versionId');
      const version = documentVersions.byId(store, versionId);
      if (!version || version.documentId !== param(req, 'id')) throw notFound('Document version');
      const rejected = rejectVersion(store, versionId, r.user!.id);
      recordAudit(store, {
        actorUserId: r.user!.id,
        actorRoles: r.user!.roles,
        action: AUDIT_ACTIONS.KNOWLEDGE_VERSION_REJECTED,
        entityType: 'document_version',
        entityId: versionId,
        ip: clientIp(req),
        metadata: { chunks: rejected, note: req.body.note ?? null },
      });
      res.json({ rejected, kbVersion: store.kbVersion });
    },
  );

  /* ---------------------------------------------------- freshness (§6 #13) */

  router.get('/admin/knowledge/sources/freshness', ...contentManager, (_req, res) => {
    const rows = [...store.documentSources.rows.values()].map((source) => {
      const version = documentVersions.byId(store, source.documentVersionId);
      const document = version ? knowledgeDocuments.byId(store, version.documentId) : undefined;
      return {
        ...publicSource(source),
        documentTitle: document?.title ?? null,
        documentVerificationStatus: document?.verificationStatus ?? null,
        recheckable: !!source.url && source.checksum !== null,
      };
    });
    res.json({
      items: rows,
      total: rows.length,
      recheckable: rows.filter((row) => row.recheckable).length,
      changed: rows.filter((row) => row.lastCheckOutcome === 'CHANGED').length,
      linkRot: rows.filter((row) => row.lastCheckOutcome === 'LINK_ROT').length,
      neverChecked: rows.filter((row) => row.lastCheckedAt === null).length,
    });
  });

  /**
   * Runs a sweep now. In production the same routine is on a schedule; here it is
   * operator-triggered so nothing fetches a government website on a timer without
   * anyone having asked.
   */
  router.post('/admin/knowledge/sources/check-freshness', ...contentManager, async (req, res) => {
    const r = req as AuthenticatedRequest;
    const started = Date.now();
    const results = await runFreshnessSweep(store);
    recordAudit(store, {
      actorUserId: r.user!.id,
      actorRoles: r.user!.roles,
      action: AUDIT_ACTIONS.KNOWLEDGE_FRESHNESS_CHECK,
      entityType: 'document_source',
      outcome: results.some((x) => x.outcome === 'ERROR') ? 'FAILURE' : 'SUCCESS',
      ip: clientIp(req),
      metadata: { checked: results.length, changed: results.filter((x) => x.outcome === 'CHANGED').length },
    });
    res.json({
      checked: results.length,
      durationMs: Date.now() - started,
      results,
      note: 'A changed or dead source is flagged for review; approved text is never replaced automatically.',
    });
  });

  /* ------------------------------------------------- knowledge gaps (§6 #14) */

  router.get('/admin/knowledge/gaps', ...contentManager, (_req, res) => {
    const rows = gapQueries.list(store, 500);
    const byIntent = new Map<string, { rows: typeof rows; terms: Map<string, number> }>();
    for (const row of rows) {
      const key = row.intent ?? 'unrouted';
      const bucket = byIntent.get(key) ?? { rows: [], terms: new Map<string, number>() };
      bucket.rows.push(row);
      for (const term of topicalTerms(row.queryText)) bucket.terms.set(term, (bucket.terms.get(term) ?? 0) + 1);
      byIntent.set(key, bucket);
    }

    const groups = [...byIntent.entries()]
      .map(([intent, bucket]) => {
        const topTerms = [...bucket.terms.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, 4)
          .map(([term]) => term);
        const unique = new Map<string, (typeof rows)[number]>();
        for (const row of bucket.rows) if (!unique.has(row.queryText)) unique.set(row.queryText, row);
        return {
          intent,
          // The label is derived from the recorded questions themselves; it is never
          // an invented category name (R10).
          topic: topTerms.length > 0 ? topTerms.join(' ') : null,
          count: bucket.rows.length,
          distinctQuestions: unique.size,
          languages: [...new Set(bucket.rows.map((row) => row.language))].sort(),
          firstSeenAt: bucket.rows.at(-1)!.occurredAt.toISOString(),
          lastSeenAt: bucket.rows[0]!.occurredAt.toISOString(),
          examples: [...unique.values()].slice(0, 5).map((row) => ({
            queryText: row.queryText,
            language: row.language,
            occurredAt: row.occurredAt.toISOString(),
          })),
        };
      })
      .sort((a, b) => b.count - a.count);

    res.json({
      items: groups,
      total: rows.length,
      // Honest framing: this counts recorded questions, not "users asking".
      note: 'Recorded only for questions that produced evidence tier NONE, with personal data already redacted. It is a count of stored questions, not of demand.',
    });
  });

  /* ------------------------------------------------ answer feedback (§6 #15) */

  router.get('/admin/feedback', ...contentManager, (_req, res) => {
    const rows = feedback.listForAdmin(store, 200);
    res.json({
      items: rows.map((f) => ({
        id: f.id,
        userId: f.userId,
        messageId: f.messageId,
        conversationId: f.conversationId,
        helpful: f.helpful,
        rating: f.rating,
        issueType: f.issueType,
        comment: f.comment,
        resolved: f.resolved,
        createdAt: f.createdAt.toISOString(),
      })),
      total: rows.length,
      open: feedback.countOpen(store),
      // Feeding `eval/golden.jsonl` is a human act: this lists candidates, it does
      // not decide that an answer was wrong (R10).
      note: 'Candidates for the golden evaluation set. Review before treating any row as a verified expectation.',
    });
  });

  return router;
}

/** Content words from the recorded question, used to label a gap group. */
function topicalTerms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 3)
    .slice(0, 12);
}
