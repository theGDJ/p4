import { createHash, randomUUID } from 'node:crypto';
import { config } from '../../config';
import type { DocType, Language } from '../../constants';
import {
  bumpKbVersion,
  documentSources,
  documentVersions,
  ingestionJobs,
  knowledgeChunks,
  knowledgeDocuments,
  type DocumentSourceRow,
  type DocumentVersionRow,
  type IngestionJobRow,
  type KnowledgeChunkRow,
  type KnowledgeDocumentRow,
  type Store,
} from '../../db/store';
import { logger } from '../../lib/logger';
import { embedTexts, type EmbeddingResult } from '../../rag/embedCache';
import { resolveEmbeddingProvider } from '../../rag/providers';
import { chunkDocument, type ChunkDraft } from './chunk';
import { detectInstructionLike, removedRatio, sanitise, stripRepeatingBoilerplate } from './clean';
import { extract } from './extract';
import { FetchError, safeFetch } from './ssrf';

/**
 * The ingestion pipeline (§5):
 *
 * ```text
 * source (upload | URL | manifest row)
 *   → extract   (PDF text layer; HTML main content; plain text)
 *   → clean     (hidden/control characters removed; instruction-like strings flagged)
 *   → chunk     (clause boundaries, 300–500 tokens, ~10% overlap, heading path prefixed)
 *   → metadata + embed (batched, cached by content hash)
 *   → PENDING_REVIEW  →  an admin approves  →  searchable
 * ```
 *
 * Three rules the code enforces rather than documents:
 *
 * - **Nothing is searchable without a human approval.** `reviewState` starts at
 *   `PENDING_REVIEW` and only the approve path changes it, while `retrievable()` is
 *   the only way the index is read (R7).
 * - **A restricted source contributes metadata only.** No content is fetched or
 *   stored, so there is nothing that could leak a paywalled standard (R11).
 * - **A failed step is stored with its reason.** The job monitor exists so that
 *   `FAILED` names the stage; a swallowed error would make a broken ingest
 *   indistinguishable from an empty knowledge base (§5, R8).
 */

export type CopyrightStatus = 'PUBLIC' | 'GOVERNMENT' | 'LICENSED' | 'RESTRICTED' | 'UNKNOWN';

export interface IngestionSpec {
  kind: 'url' | 'upload' | 'manual' | 'manifest';
  /** For `url` and manifest rows. */
  url?: string;
  /** For `upload`: base64 body + its name, so the API stays JSON. */
  filename?: string;
  contentBase64?: string;
  /** For `manual` and manifest rows without a URL. */
  text?: string;
  title: string;
  docType: DocType;
  language: Language;
  standardNo?: string | null;
  publisher?: string | null;
  licenseNote?: string | null;
  copyrightStatus?: CopyrightStatus;
  /** R11: `restricted` means metadata-only; no content is stored or fetched. */
  accessLevel?: 'open' | 'restricted';
  publishedDate?: string | null;
  revisedDate?: string | null;
  requestedBy: string;
  /** When set, an existing document gets a new version instead of a new document. */
  documentId?: string | null;
  /**
   * Allow a document whose extracted text contains block-severity instruction-like
   * strings into review anyway. Off by default; approving it remains a separate,
   * audited act either way, because the flags are stored on the chunk.
   */
  overrideInjectionFlags?: boolean;
  /** Re-ingest even when the content hash is unchanged. */
  force?: boolean;
  /** Manifest rows marked `approved` are approved by the CONTENT_MANAGER who submitted them. */
  autoApprove?: boolean;
}

class StageError extends Error {
  constructor(
    readonly stage: NonNullable<IngestionJobRow['stage']>,
    message: string,
  ) {
    super(message);
    this.name = 'StageError';
  }
}

/** Payload fields are dropped before the spec is stored on the job row. */
function specForStorage(spec: IngestionSpec): Record<string, unknown> {
  const { contentBase64: _b64, text: _text, ...rest } = spec;
  void _b64;
  void _text;
  return rest;
}

export function newJob(store: Store, spec: IngestionSpec): IngestionJobRow {
  const now = new Date();
  const job: IngestionJobRow = {
    id: randomUUID(),
    documentId: spec.documentId ?? null,
    documentVersionId: null,
    sourceKind: spec.kind === 'url' ? 'url' : spec.kind === 'upload' ? 'upload' : spec.kind,
    sourceLabel: spec.url ?? spec.filename ?? null,
    state: 'QUEUED',
    stage: 'QUEUED',
    error: null,
    warnings: [],
    attempts: 0,
    maxAttempts: 3,
    nextAttemptAt: null,
    chunksProduced: 0,
    requestedBy: spec.requestedBy,
    spec: specForStorage(spec),
    needsResubmit: spec.kind === 'upload' || (spec.kind === 'manual' && !spec.url),
    startedAt: null,
    finishedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  return ingestionJobs.put(store, job);
}

/**
 * Starts a job without blocking the request that queued it. The promise is
 * returned as well so callers that need determinism (tests, the manifest importer)
 * can await it instead of polling.
 */
export function startJob(store: Store, jobId: string, spec: IngestionSpec): Promise<IngestionJobRow> {
  const run = runJob(store, jobId, spec);
  // runJob records failures on the row; this catch only stops an unhandled
  // rejection from taking down the dev server.
  void run.catch((err: unknown) => logger.error('ingestion job rejected', { jobId, err }));
  return run;
}

export async function runJob(store: Store, jobId: string, spec: IngestionSpec): Promise<IngestionJobRow> {
  const job = ingestionJobs.byId(store, jobId);
  if (!job) throw new Error('Unknown ingestion job');
  if (job.state === 'RUNNING') return job;

  const c = config();
  job.state = 'RUNNING';
  job.attempts += 1;
  job.error = null;
  job.startedAt ??= new Date();
  job.updatedAt = new Date();

  try {
    // R11 first, before any request is made: a restricted standard must not be
    // downloaded "and then discarded". The check sits above the fetch precisely so
    // that the code cannot fetch by accident on some later path.
    if ((spec.accessLevel ?? 'open') === 'restricted') {
      await step(job, 'FETCH', async () => {
        if (spec.url) {
          job.warnings.push(`A URL was supplied for a restricted item and was deliberately not fetched (R11): ${new URL(spec.url).host}`);
        }
        return null;
      });
      const restricted = await step(job, 'PERSIST', () => Promise.resolve(persistRestrictedMetadata(store, spec)));
      job.state = 'DONE';
      job.stage = 'DONE';
      job.chunksProduced = 0;
      job.documentId = restricted.documentId;
      job.documentVersionId = restricted.versionId;
      job.finishedAt = new Date();
      job.nextAttemptAt = null;
      job.updatedAt = new Date();
      job.warnings.push(
        restricted.unchanged
          ? 'Restricted source: its metadata is already recorded and unchanged, so no new version was created (R2, R11).'
          : 'Restricted source: metadata only. No text was fetched or stored (R11), so it is not searchable by design.',
      );
      return job;
    }

    const fetched = await step(job, 'FETCH', () => fetchSource(spec, c.INGEST_MAX_BYTES));

    const extracted = await step(job, 'EXTRACT', async () => {
      const result = await extract(fetched.body, fetched.contentType, spec.filename);
      if (result.needsOcr) {
        throw new StageError(
          'EXTRACT',
          `No usable text layer (${result.characters} characters over ${result.pages ?? 1} page(s)). This looks like a scanned PDF, and OCR is not part of this deployment.`,
        );
      }
      if (result.characters < 80) {
        throw new StageError('EXTRACT', `The source yielded almost no text (${result.characters} characters). Nothing was stored.`);
      }
      job.warnings.push(...result.warnings);
      return result;
    });

    const cleaned = await step(job, 'CLEAN', async () => {
      const sanitised = sanitise(extracted.text);
      if (sanitised.removed.controlChars > 0 || sanitised.removed.invisibleChars > 0) {
        const ratio = (removedRatio(extracted.text.length, sanitised.text.length) * 100).toFixed(1);
        job.warnings.push(
          `Removed ${sanitised.removed.controlChars} control and ${sanitised.removed.invisibleChars} invisible character(s) (${ratio}% of the raw length).`,
        );
      }
      if (sanitised.requiresReview && !spec.overrideInjectionFlags) {
        throw new StageError(
          'CLEAN',
          `Refused: the source contains instruction-like strings (${sanitised.flags
            .filter((f) => f.severity === 'block')
            .map((f) => f.rule)
            .join(', ')}). Re-submit with overrideInjectionFlags if the text is legitimate — the flags stay visible to the reviewer either way.`,
        );
      }
      if (sanitised.flags.length > 0) {
        job.warnings.push(`${sanitised.flags.length} instruction-like string(s) flagged for review; the text was stored unchanged.`);
      }
      if (sanitised.text.length < 40) {
        throw new StageError('CLEAN', 'Nothing but boilerplate remained after cleaning. Nothing was stored.');
      }
      return sanitised;
    });

    const drafts = await step(job, 'CHUNK', async () => {
      const split = cleaned.text.split(/\n{2,}/).flatMap((para) => para.split('\n'));
      const deduped = stripRepeatingBoilerplate(split);
      if (deduped.removed.length > 0) {
        job.warnings.push(`Dropped ${deduped.removed.length} repeated boilerplate line(s) (running header, footer or page numbers).`);
      }
      const produced = chunkDocument(deduped.blocks.join('\n'));
      if (produced.length === 0) throw new StageError('CHUNK', 'Chunking produced no chunk; the cleaned text was too short.');
      if (produced.length > c.INGEST_MAX_PAGES * 4) {
        throw new StageError('CHUNK', `Refusing a document that would produce ${produced.length} chunks (limit ${c.INGEST_MAX_PAGES * 4}).`);
      }
      return produced;
    });

    const embedded = await step(job, 'EMBED', async () => {
      const provider = resolveEmbeddingProvider();
      const result = await embedTexts(
        drafts.map((d) => d.content),
        provider,
      );
      if (provider.isMock) {
        job.warnings.push(
          'Embeddings came from the offline hashing provider: they are stored so the column is honest, but they are not semantically meaningful, so vector ranking is inactive (see docs/ENVIRONMENT.md).',
        );
      }
      if (result.cacheHits > 0) {
        job.warnings.push(`${result.cacheHits} chunk(s) reused from the embedding cache (§9).`);
      }
      if (result.vectors.length !== drafts.length) {
        throw new StageError('EMBED', `Embedded ${result.vectors.length} of ${drafts.length} chunk(s); nothing was stored.`);
      }
      return result;
    });

    const persisted = await step(job, 'PERSIST', async () =>
      Promise.resolve(persistChunks(store, spec, job, drafts, embedded, fetched.sourceChecksum, fetched.finalUrl)),
    );

    if (spec.autoApprove && persisted.chunksWritten > 0) {
      // Only a manifest row already marked approved, and only for the CONTENT_MANAGER
      // who submitted it: the reviewer and the ingest request are the same audited act.
      const approved = approveVersion(store, persisted.versionId, spec.requestedBy);
      job.warnings.push(`${approved} chunk(s) approved at submission because the manifest row was marked approved.`);
    }

    job.state = 'DONE';
    job.stage = 'DONE';
    job.chunksProduced = persisted.chunksWritten;
    job.documentId = persisted.documentId;
    job.documentVersionId = persisted.versionId;
    job.finishedAt = new Date();
    job.nextAttemptAt = null;
    job.updatedAt = new Date();
    logger.info('ingestion job finished', {
      jobId: job.id,
      documentId: persisted.documentId,
      versionId: persisted.versionId,
      chunks: persisted.chunksWritten,
      pendingReview: !spec.autoApprove,
    });
    return job;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ingestion failed.';
    job.state = 'FAILED';
    job.stage = err instanceof StageError ? err.stage : job.stage;
    job.error = message.slice(0, 500);
    job.finishedAt = new Date();
    // §5 "retryable job": exponential backoff until maxAttempts is reached.
    job.nextAttemptAt = job.attempts < job.maxAttempts ? new Date(Date.now() + 5_000 * 2 ** (job.attempts - 1)) : null;
    job.updatedAt = new Date();
    if (err instanceof FetchError) {
      // A blocked-address refusal must not echo the internal address it resolved to.
      logger.warn('ingestion fetch refused', { jobId: job.id, kind: err.kind });
    } else {
      logger.error('ingestion job failed', { jobId: job.id, stage: job.stage, err });
    }
    return job;
  }
}

async function step<T>(
  job: IngestionJobRow,
  stage: NonNullable<IngestionJobRow['stage']>,
  fn: () => Promise<T>,
): Promise<T> {
  job.stage = stage;
  job.updatedAt = new Date();
  try {
    return await fn();
  } catch (err) {
    if (err instanceof StageError) throw err;
    throw new StageError(stage, err instanceof Error ? err.message : `The ${stage.toLowerCase()} step failed.`);
  }
}

/* ------------------------------------------------------------- source types */

interface Fetched {
  body: Buffer;
  contentType: string;
  filename: string | null;
  /** SHA-256 of the raw bytes: what the freshness monitor re-fetches and compares. */
  sourceChecksum: string;
  finalUrl: string | null;
}

async function fetchSource(spec: IngestionSpec, maxBytes: number): Promise<Fetched> {
  if (spec.kind === 'url' || (spec.kind === 'manifest' && spec.url)) {
    if (!spec.url) throw new StageError('FETCH', 'No URL was supplied.');
    const doc = await safeFetch(spec.url, { maxBytes });
    return {
      body: doc.body,
      contentType: doc.contentType,
      filename: null,
      sourceChecksum: doc.sha256,
      finalUrl: doc.finalUrl,
    };
  }

  if (spec.kind === 'upload') {
    const encoded = spec.contentBase64 ?? '';
    if (encoded.length === 0) throw new StageError('FETCH', 'No file content was supplied.');
    // Check the decoded size before allocating it: 4 base64 chars ≈ 3 bytes.
    if (Math.floor((encoded.length * 3) / 4) > maxBytes) {
      throw new StageError('FETCH', `The upload exceeds the ${Math.round(maxBytes / 1_000_000)} MB ingestion limit.`);
    }
    const body = Buffer.from(encoded, 'base64');
    if (body.length === 0) throw new StageError('FETCH', 'The upload was empty or not valid base64.');
    if (body.length > maxBytes) {
      throw new StageError('FETCH', `The upload exceeds the ${Math.round(maxBytes / 1_000_000)} MB ingestion limit.`);
    }
    const name = (spec.filename ?? '').toLowerCase();
    const isPdf = body.subarray(0, 5).toString('latin1') === '%PDF-';
    if (isPdf) {
      return {
        body,
        contentType: 'application/pdf',
        filename: spec.filename ?? null,
        sourceChecksum: createHash('sha256').update(body).digest('hex'),
        finalUrl: null,
      };
    }
    // Magic bytes beat the extension: a `.pdf` that is not a PDF is either a
    // mislabel or a disguised upload, and both deserve a hard stop.
    if (name.endsWith('.pdf')) {
      throw new StageError('FETCH', 'That file claims to be a PDF but has no PDF header.');
    }
    if (!/\.(txt|md|markdown|html?|csv)$/.test(name)) {
      throw new StageError('FETCH', 'Unsupported file type. Ingestion accepts .pdf, .html, .txt, .md and .csv.');
    }
    const contentType = /\.html?$/.test(name) ? 'text/html' : /\.(md|markdown)$/.test(name) ? 'text/markdown' : 'text/plain';
    return {
      body,
      contentType,
      filename: spec.filename ?? null,
      sourceChecksum: createHash('sha256').update(body).digest('hex'),
      finalUrl: null,
    };
  }

  const text = spec.text ?? '';
  if (text.trim().length === 0) throw new StageError('FETCH', 'No text was supplied.');
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new StageError('FETCH', `The pasted text exceeds the ${Math.round(maxBytes / 1_000_000)} MB limit.`);
  }
  return {
    body: Buffer.from(text, 'utf8'),
    contentType: looksLikeHtml(text) ? 'text/html' : 'text/plain',
    filename: null,
    sourceChecksum: createHash('sha256').update(text, 'utf8').digest('hex'),
    finalUrl: null,
  };
}

/** A pasted document may legitimately be the HTML an operator copied. */
function looksLikeHtml(text: string): boolean {
  return /<\s*(html|body|article|main|div)[\s>]/i.test(text.slice(0, 2_000));
}

/* --------------------------------------------------------------- persistence */

interface Persisted {
  documentId: string;
  versionId: string;
  chunksWritten: number;
  /** True when the submission matched what is already recorded, so nothing changed (R2). */
  unchanged?: boolean;
}

function resolveDocument(store: Store, spec: IngestionSpec): KnowledgeDocumentRow | undefined {
  if (spec.documentId) return knowledgeDocuments.byId(store, spec.documentId);
  if (spec.standardNo) return knowledgeDocuments.byStandardNo(store, spec.standardNo);
  return undefined;
}

function persistRestrictedMetadata(store: Store, spec: IngestionSpec): Persisted {
  const now = new Date();
  const existing = resolveDocument(store, spec);
  const document: KnowledgeDocumentRow = existing ?? {
    id: randomUUID(),
    title: spec.title,
    standardNo: spec.standardNo ?? null,
    docType: spec.docType,
    language: spec.language,
    accessLevel: 'restricted',
    verificationStatus: 'RESTRICTED',
    approvedAt: null,
    publisher: spec.publisher ?? null,
    latestVersionNo: 0,
    createdAt: now,
    updatedAt: now,
  };
  document.accessLevel = 'restricted';
  // R11: the row says *why* there is no text, so nobody later reads an empty
  // document as a failed ingest.
  document.verificationStatus = 'RESTRICTED';
  document.title = spec.title || document.title;
  document.publisher = spec.publisher ?? document.publisher;
  document.updatedAt = now;

  // The hash covers the citation metadata, because no content is held.
  const restrictedHash = createHash('sha256').update(`restricted|${spec.title}|${spec.url ?? ''}|${spec.licenseNote ?? ''}`).digest('hex');
  const current = documentVersions.currentFor(store, document.id);
  if (current && current.contentHash === restrictedHash) {
    // Same metadata, so nothing changed: no new version, and the job's warning says so
    // (R2 — a re-submission never rewrites what is already recorded).
    return { documentId: document.id, versionId: current.id, chunksWritten: 0, unchanged: true };
  }

  const versionNo = document.latestVersionNo + 1;
  documentVersions.supersedeCurrent(store, document.id, now);
  const version: DocumentVersionRow = {
    id: randomUUID(),
    documentId: document.id,
    versionNo,
    contentHash: restrictedHash,
    publishedDate: spec.publishedDate ?? null,
    revisedDate: spec.revisedDate ?? null,
    isCurrent: true,
    createdAt: now,
    updatedAt: now,
  };
  document.latestVersionNo = versionNo;
  knowledgeDocuments.put(store, document);
  documentVersions.put(store, version);
  putSource(store, version.id, {
    sourceKind: spec.url ? 'url' : 'manual',
    url: spec.url ?? null,
    publisher: spec.publisher ?? null,
    // No checksum: nothing was fetched, so there is nothing to diff against.
    checksum: null,
    licenseNote: spec.licenseNote ?? null,
    copyrightStatus: spec.copyrightStatus ?? 'RESTRICTED',
  });
  return { documentId: document.id, versionId: version.id, chunksWritten: 0 };
}

function putSource(
  store: Store,
  versionId: string,
  input: {
    sourceKind: DocumentSourceRow['sourceKind'];
    url: string | null;
    publisher: string | null;
    checksum: string | null;
    licenseNote: string | null;
    copyrightStatus: CopyrightStatus;
  },
): DocumentSourceRow {
  const now = new Date();
  return documentSources.put(store, {
    id: randomUUID(),
    documentVersionId: versionId,
    sourceKind: input.sourceKind,
    url: input.url,
    publisher: input.publisher,
    retrievedAt: now,
    checksum: input.checksum,
    licenseNote: input.licenseNote,
    copyrightStatus: input.copyrightStatus,
    lastCheckedAt: null,
    lastCheckOutcome: null,
    lastCheckDetail: null,
    createdAt: now,
    updatedAt: now,
  });
}

function persistChunks(
  store: Store,
  spec: IngestionSpec,
  job: IngestionJobRow,
  drafts: ChunkDraft[],
  embedded: EmbeddingResult,
  sourceChecksum: string,
  finalUrl: string | null,
): Persisted {
  const now = new Date();
  const documentHash = createHash('sha256')
    .update(drafts.map((d) => d.content).join('\u0001'))
    .digest('hex');

  const existing = resolveDocument(store, spec);
  if (existing && !spec.force) {
    const current = documentVersions.currentFor(store, existing.id);
    if (current && current.contentHash === documentHash) {
      job.warnings.push('Content is identical to the current version, so no new version was created (§5: re-embed only changed chunks).');
      return { documentId: existing.id, versionId: current.id, chunksWritten: 0 };
    }
  }

  const document: KnowledgeDocumentRow = existing ?? {
    id: randomUUID(),
    title: spec.title,
    standardNo: spec.standardNo ?? null,
    docType: spec.docType,
    language: spec.language,
    accessLevel: 'open',
    verificationStatus: 'UNVERIFIED',
    approvedAt: null,
    publisher: spec.publisher ?? null,
    latestVersionNo: 0,
    createdAt: now,
    updatedAt: now,
  };
  // A re-ingest updates the document's descriptive fields but never rewrites an
  // existing version: citations point at versions, so rewriting one would change
  // the evidence behind answers already shown (R2).
  document.title = spec.title || document.title;
  document.docType = spec.docType;
  document.language = spec.language;
  document.standardNo = spec.standardNo ?? document.standardNo;
  document.publisher = spec.publisher ?? document.publisher;
  document.accessLevel = 'open';
  document.verificationStatus = 'UNVERIFIED';
  document.approvedAt = null;
  document.updatedAt = now;

  const versionNo = document.latestVersionNo + 1;
  documentVersions.supersedeCurrent(store, document.id, now);
  const version: DocumentVersionRow = {
    id: randomUUID(),
    documentId: document.id,
    versionNo,
    contentHash: documentHash,
    publishedDate: spec.publishedDate ?? null,
    revisedDate: spec.revisedDate ?? null,
    isCurrent: true,
    createdAt: now,
    updatedAt: now,
  };
  document.latestVersionNo = versionNo;
  knowledgeDocuments.put(store, document);
  documentVersions.put(store, version);
  putSource(store, version.id, {
    sourceKind: spec.kind === 'upload' ? 'file' : finalUrl || spec.url ? 'url' : 'manual',
    // The final URL after redirects is the honest provenance (R2).
    url: finalUrl ?? spec.url ?? null,
    publisher: spec.publisher ?? null,
    checksum: sourceChecksum,
    licenseNote: spec.licenseNote ?? null,
    copyrightStatus: spec.copyrightStatus ?? 'UNKNOWN',
  });

  drafts.forEach((draft, index) => {
    // Flags are computed per chunk rather than copied from the document pass: the
    // reviewer needs to know *which* chunk carries an instruction-like sentence.
    const chunkFlags = detectInstructionLike(draft.content).map((f) => ({
      rule: f.rule,
      severity: f.severity,
      excerpt: f.excerpt,
    }));
    const row: KnowledgeChunkRow = {
      id: randomUUID(),
      documentId: document.id,
      documentVersionId: version.id,
      ordinal: index + 1,
      title: document.title,
      standardNo: document.standardNo,
      section: draft.section,
      headingPath: draft.headingPath,
      docType: document.docType,
      language: document.language,
      sourceUrl: finalUrl ?? spec.url ?? null,
      publishedDate: spec.publishedDate ?? null,
      revisedDate: spec.revisedDate ?? null,
      verificationStatus: 'UNVERIFIED',
      verifiedBy: null,
      verifiedAt: null,
      reviewState: 'PENDING_REVIEW',
      reviewedBy: null,
      reviewedAt: null,
      content: draft.content,
      contentHash: createHash('sha256').update(draft.content).digest('hex'),
      tokenCount: draft.tokenCount,
      embeddingModel: embedded.model,
      embeddedAt: now,
      embedding: embedded.vectors[index] ?? null,
      metadata: {
        pages: draft.pages,
        firstLine: draft.firstLine,
        lastLine: draft.lastLine,
        overlapTokens: draft.overlapTokens,
        injectionFlags: chunkFlags,
        documentContentHash: documentHash,
      },
      ingestedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    knowledgeChunks.put(store, row);
  });

  return { documentId: document.id, versionId: version.id, chunksWritten: drafts.length };
}

/**
 * Marks a document version searchable. This is the only path that sets
 * `reviewState = APPROVED`, and the reason a kbVersion bump is mandatory: cached
 * answers computed against the older index must not be served afterwards (§9).
 */
export function approveVersion(store: Store, versionId: string, reviewerId: string): number {
  const version = documentVersions.byId(store, versionId);
  if (!version) return 0;
  const approved = knowledgeChunks.approveVersion(store, versionId, reviewerId);
  if (approved === 0) return 0;
  const document = knowledgeDocuments.byId(store, version.documentId);
  if (document) {
    document.approvedAt = new Date();
    document.verificationStatus = 'VERIFIED';
    document.updatedAt = new Date();
  }
  // No `bumpKbVersion` here: the store's approveVersion already counted this as one
  // knowledge-base change, and bumping twice would make the version number mean
  // nothing to the answer cache.
  return approved;
}

export function rejectVersion(store: Store, versionId: string, reviewerId: string): number {
  const version = documentVersions.byId(store, versionId);
  if (!version) return 0;
  let n = 0;
  for (const chunk of knowledgeChunks.forVersion(store, versionId)) {
    if (knowledgeChunks.reject(store, chunk.id, reviewerId)) n += 1;
  }
  const document = knowledgeDocuments.byId(store, version.documentId);
  if (document) {
    document.verificationStatus = 'UNVERIFIED';
    document.updatedAt = new Date();
  }
  return n;
}

/**
 * §6 #13 — freshness monitor. Re-fetch a source URL and compare content hashes.
 * A change or a dead link is flagged for review; it never rewrites the approved
 * index on its own, because automatic ingestion without review would let a
 * compromised source push content straight into answers.
 */
export type FreshnessOutcome = 'UNCHANGED' | 'CHANGED' | 'LINK_ROT' | 'ERROR' | 'SKIPPED';

export interface FreshnessCheckResult {
  sourceId: string;
  documentId: string | null;
  documentTitle: string | null;
  url: string;
  outcome: FreshnessOutcome;
  detail: string;
}

export async function checkFreshness(store: Store, source: DocumentSourceRow): Promise<FreshnessCheckResult> {
  const url = source.url ?? '';
  const version = documentVersions.byId(store, source.documentVersionId);
  const document = version ? knowledgeDocuments.byId(store, version.documentId) : undefined;
  const base = {
    sourceId: source.id,
    documentId: version?.documentId ?? null,
    documentTitle: document?.title ?? null,
    url,
  };

  if (!url) {
    return { ...base, outcome: 'SKIPPED', detail: 'This version was not fetched from a URL, so there is nothing to re-check.' };
  }
  if (source.checksum === null) {
    return { ...base, outcome: 'SKIPPED', detail: 'No checksum was recorded at ingestion, so a content diff is impossible.' };
  }

  let outcome: FreshnessCheckResult['outcome'] = 'UNCHANGED';
  let detail = 'Content hash matches the ingested version.';
  try {
    const doc = await safeFetch(url);
    outcome = doc.sha256 === source.checksum ? 'UNCHANGED' : 'CHANGED';
    detail =
      outcome === 'CHANGED'
        ? 'The source now returns different bytes. A content manager must re-ingest and review before this change reaches answers.'
                : 'The source is byte-identical to the ingested version.';
  } catch (err) {
    if (err instanceof FetchError && err.kind === 'not-found') {
      outcome = 'LINK_ROT';
      detail = err.message;
    } else {
      outcome = 'ERROR';
      detail = err instanceof Error ? err.message : 'The check could not be completed.';
    }
  }

  const now = new Date();
  source.lastCheckedAt = now;
  source.lastCheckOutcome = outcome;
  source.lastCheckDetail = detail.slice(0, 400);
  source.updatedAt = now;
  documentSources.put(store, source);

  if ((outcome === 'CHANGED' || outcome === 'LINK_ROT') && document && document.verificationStatus === 'VERIFIED') {
    // Outdated does not mean unretrievable — it means the badge and the queue must
    // say so, and a human decides whether the approved text stays (R7).
    document.verificationStatus = 'OUTDATED';
    document.updatedAt = now;
    knowledgeDocuments.put(store, document);
  }

  return { ...base, outcome, detail };
}

export async function runFreshnessSweep(store: Store, limit = 50): Promise<FreshnessCheckResult[]> {
  const targets = documentSources.checkable(store).slice(0, limit);
  const results: FreshnessCheckResult[] = [];
  // Sequential on purpose: an operator's scheduled sweep must not fan out into a
  // self-inflicted denial-of-service against a government website.
  for (const source of targets) results.push(await checkFreshness(store, source));
  return results;
}

/** Re-queues a failed job from the stored spec (no client round-trip needed). */
export async function retryJob(store: Store, jobId: string): Promise<{ job: IngestionJobRow | null; message: string }> {
  const job = ingestionJobs.byId(store, jobId);
  if (!job) return { job: null, message: 'Job not found.' };
  if (!ingestionJobs.isRetryable(job)) {
    return {
      job,
      message:
        job.state !== 'FAILED'
          ? `A ${job.state.toLowerCase()} job cannot be retried.`
          : job.needsResubmit
            ? 'This job consumed an upload, so it must be re-submitted with the file rather than retried.'
            : `This job has used its ${job.maxAttempts} attempts; the source needs looking at, not another retry.`,
    };
  }
  if (job.needsResubmit || !job.spec) {
    job.state = 'FAILED';
    job.error = 'This job consumed a pasted or uploaded payload; re-submit it instead of retrying.';
    job.updatedAt = new Date();
    return { job, message: job.error };
  }
  // A retry never auto-approves: content that failed once should be looked at
  // before it becomes searchable, and the reviewer's identity must be a real user.
  const spec = { ...(job.spec as unknown as IngestionSpec), requestedBy: job.requestedBy ?? '', autoApprove: false };
  job.state = 'QUEUED';
  job.stage = 'QUEUED';
  job.updatedAt = new Date();
  await runJob(store, job.id, spec);
  return { job, message: `Retried (attempt ${job.attempts}); state is now ${job.state}.` };
}
