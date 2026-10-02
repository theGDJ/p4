import { apiFetch } from './api';
import type {
  ApproveVersionResponse,
  ChunkListResponse,
  DocumentDetail,
  DocumentListResponse,
  FeedbackListResponse,
  FreshnessResponse,
  FreshnessSweepResponse,
  GapsResponse,
  IngestMeta,
  IngestionAccepted,
  IngestionJob,
  IngestionJobsResponse,
  KnowledgeChunkDetail,
  ManifestResponse,
  RejectVersionResponse,
  ReviewState,
} from './types';

/**
 * The admin surface of docs/API.md (§5 ingestion, §6 #4/#11/#12/#13/#15).
 *
 * Two things every caller here has to accept, and this module encodes both rather than
 * leaving each page to rediscover them:
 *
 * 1. Submission is asynchronous. A 202 hands back a job and a `poll` path; the text is
 *    not searchable yet, so no function here returns anything that reads like success.
 * 2. Publishing needs a person. Approving is the only way a chunk becomes retrievable,
 *    and a rejection invalidates cached answers exactly like an approval — so both take a
 *    note, and the note is stored as the reason a human did this.
 */

const BASE = '/admin';

/** Throttled submissions answer 429 with `Retry-After`; `apiFetch` throws an ApiError. */
export function submitText(payload: IngestMeta & { content: string }): Promise<IngestionAccepted> {
  return apiFetch<IngestionAccepted>(`${BASE}/ingestion/text`, { method: 'POST', body: payload });
}

export function submitUrl(payload: IngestMeta & { url: string }): Promise<IngestionAccepted> {
  return apiFetch<IngestionAccepted>(`${BASE}/ingestion/url`, { method: 'POST', body: payload });
}

/**
 * Uploads a file as base64 JSON rather than multipart: the contract is JSON end to end
 * (docs/API.md), and one content type keeps the browser and the mock honest about the same
 * size cap — `INGEST_MAX_BYTES` is enforced while streaming, not from a header.
 */
export async function submitFile(file: File, meta: IngestMeta): Promise<IngestionAccepted> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i] as number);
  return apiFetch<IngestionAccepted>(`${BASE}/ingestion/upload`, {
    method: 'POST',
    body: { ...meta, filename: file.name, contentBase64: btoa(binary) },
  });
}

export function submitManifest(csv: string, honorApprovedStatus = true): Promise<ManifestResponse> {
  return apiFetch<ManifestResponse>(`${BASE}/ingestion/manifest`, {
    method: 'POST',
    body: { csv, honorApprovedStatus },
  });
}

export function listJobs(): Promise<IngestionJobsResponse> {
  return apiFetch<IngestionJobsResponse>(`${BASE}/ingestion/jobs`);
}

export function getJob(id: string): Promise<IngestionJob> {
  return apiFetch<IngestionJob>(`${BASE}/ingestion/jobs/${id}`);
}

export function retryJob(id: string): Promise<{ message: string; job: IngestionJob | null }> {
  return apiFetch<{ message: string; job: IngestionJob | null }>(`${BASE}/ingestion/jobs/${id}/retry`, {
    method: 'POST',
  });
}

export function listDocuments(): Promise<DocumentListResponse> {
  return apiFetch<DocumentListResponse>(`${BASE}/knowledge/documents`);
}

export function getDocument(id: string): Promise<DocumentDetail> {
  return apiFetch<DocumentDetail>(`${BASE}/knowledge/documents/${id}`);
}

export function listChunks(params: {
  reviewState?: ReviewState | 'ALL';
  documentId?: string;
  versionId?: string;
  limit?: number;
  offset?: number;
}): Promise<ChunkListResponse> {
  return apiFetch<ChunkListResponse>(`${BASE}/knowledge/chunks`, { query: { ...params } });
}

export function getChunk(id: string): Promise<KnowledgeChunkDetail> {
  return apiFetch<KnowledgeChunkDetail>(`${BASE}/knowledge/chunks/${id}`);
}

export function approveChunk(id: string, note: string): Promise<KnowledgeChunkDetail> {
  return apiFetch<KnowledgeChunkDetail>(`${BASE}/knowledge/chunks/${id}/approve`, {
    method: 'POST',
    body: { note },
  });
}

export function rejectChunk(id: string, note: string): Promise<KnowledgeChunkDetail> {
  return apiFetch<KnowledgeChunkDetail>(`${BASE}/knowledge/chunks/${id}/reject`, {
    method: 'POST',
    body: { note },
  });
}

export function approveVersion(documentId: string, versionId: string, note: string): Promise<ApproveVersionResponse> {
  return apiFetch<ApproveVersionResponse>(`${BASE}/knowledge/documents/${documentId}/versions/${versionId}/approve`, {
    method: 'POST',
    body: { note },
  });
}

export function rejectVersion(documentId: string, versionId: string, note: string): Promise<RejectVersionResponse> {
  return apiFetch<RejectVersionResponse>(`${BASE}/knowledge/documents/${documentId}/versions/${versionId}/reject`, {
    method: 'POST',
    body: { note },
  });
}

export function freshness(): Promise<FreshnessResponse> {
  return apiFetch<FreshnessResponse>(`${BASE}/knowledge/sources/freshness`);
}

export function checkFreshness(): Promise<FreshnessSweepResponse> {
  return apiFetch<FreshnessSweepResponse>(`${BASE}/knowledge/sources/check-freshness`, { method: 'POST', body: {} });
}

export function gaps(): Promise<GapsResponse> {
  return apiFetch<GapsResponse>(`${BASE}/knowledge/gaps`);
}

export function openFeedback(): Promise<FeedbackListResponse> {
  return apiFetch<FeedbackListResponse>(`${BASE}/feedback`);
}

/**
 * Polls a job the way the contract expects a client to: until it settles, with a bounded
 * wait. `state` is `QUEUED|RUNNING|DONE|FAILED`, so "settled" means not those first two —
 * and a job that never settles is reported as still running rather than assumed done (R8).
 */
export async function waitForJob(
  id: string,
  { timeoutMs = 60_000, intervalMs = 700, signal }: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal } = {},
): Promise<IngestionJob> {
  const deadline = Date.now() + timeoutMs;
  let job = await getJob(id);
  while ((job.state === 'QUEUED' || job.state === 'RUNNING') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    if (signal?.aborted) return job;
    job = await getJob(id);
  }
  return job;
}
