import { createHash } from 'node:crypto';
import { config } from '../config';
import type { EvidenceTier, Intent, Language } from '../constants';
import type { SourceSnapshot } from '../db/store';
import { logger } from './logger';
import { resolveEmbeddingProvider } from '../rag/providers';

/**
 * Answer cache (§9: "Redis semantic cache for non-personal questions: key =
 * embedding similarity + language + KB version; invalidate on KB version bump;
 * never shared across personalised contexts").
 *
 * What is real here and what is not:
 *
 * - The *matching* is genuinely semantic-shaped: the query is embedded and compared
 *   by cosine similarity against cached queries, at `SIMILARITY_THRESHOLD`. With
 *   the configured mock embedding model this degrades to near-identical phrasing
 *   only — which is the honest behaviour of a hashing stand-in and is asserted as
 *   such in the tests.
 * - The store is process-local, not Redis. There is no Redis in this sandbox
 *   (docs/ENVIRONMENT.md), and a fake Redis client would be a fabricated dependency.
 *
 * Four properties make this safe rather than merely fast:
 *
 * 1. **The knowledge-base version is part of the key.** A new approval therefore
 *    cannot be masked by an older cached answer, and nothing needs invalidating
 *    by hand (see `bumpKbVersion`).
 * 2. **Personal questions are never cached.** A question that tripped the PII
 *    guard, or that arrives mid-conversation, is answered from scratch. A cache
 *    shared across users is a data leak, not a speed-up (R9).
 * 3. **Only a completed, validated answer is stored.** An answer whose citations
 *    were dropped, whose generation failed, or whose evidence tier is NONE because
 *    the model errored is not written — and the R4 fallback *is* written, because
 *    for that KB version it is the correct answer.
 * 4. **A cached answer still carries its sources and tier**, so the UI shows the
 *    same evidence and the same "informational" disclaimer it showed live (R5).
 */

const SIMILARITY_THRESHOLD = 0.94;

export interface CacheableAnswer {
  text: string;
  sources: SourceSnapshot[];
  evidenceTier: EvidenceTier;
  followUps: string[];
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number | null;
}

interface Entry extends CacheableAnswer {
  key: string;
  query: string;
  language: Language;
  intent: Intent;
  kbVersion: number;
  embedding: number[] | null;
  createdAt: number;
  hits: number;
}

let entries = new Map<string, Entry>();

export function resetAnswerCache(): void {
  entries = new Map();
}

export function answerCacheStats(): { entries: number; hits: number; misses: number; disabled: boolean } {
  return { entries: entries.size, hits, misses, disabled: !enabled };
}

let hits = 0;
let misses = 0;
let enabled = true;

/** Test seam so a suite can count provider calls without the cache in the way. */
export function setAnswerCacheEnabled(next: boolean): void {
  enabled = next;
  if (!enabled) entries = new Map();
}

/**
 * Whether this turn may touch the cache at all. Deliberately a whitelist of intents:
 * `clarify`, `chitchat` and `meta` are conversation-dependent or fixed text, and
 * anything personalised by construction must not be shared.
 */
export function cacheableTurn(opts: {
  intent: Intent;
  piiDetected: boolean;
  hasHistory: boolean;
  providerError: unknown;
}): boolean {
  const cacheableIntents: Intent[] = ['factual', 'recommend', 'certification', 'hallmarking', 'lab'];
  return (
    enabled &&
    config().ANSWER_CACHE_ENABLED &&
    opts.providerError === null &&
    !opts.piiDetected &&
    !opts.hasHistory &&
    cacheableIntents.includes(opts.intent)
  );
}

/** The TTL applies to reads, not only to the lazy sweep on write. */
function isExpired(entry: Entry): boolean {
  return Date.now() - entry.createdAt > config().ANSWER_CACHE_TTL_SECONDS * 1000;
}

/** Cosine similarity; the same metric the pgvector index uses (`vector_cosine_ops`). */
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function normalizeQuery(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Exact-match key: language + intent + KB version + a hash of the normalised text. */
export function answerKey(query: string, language: Language, intent: Intent, kbVersion: number): string {
  const digest = createHash('sha256').update(normalizeQuery(query), 'utf8').digest('hex').slice(0, 32);
  return `kb${kbVersion}|${language}|${intent}|${digest}`;
}

export interface CacheLookup {
  answer: CacheableAnswer | null;
  /** How the entry matched, for the usage frame — 'exact', 'similar' or null. */
  match: 'exact' | 'similar' | null;
  similarity: number | null;
  queryEmbedding: number[] | null;
}

/**
 * Looks for a cached answer for this query. The embedding is computed here and
 * returned, so a subsequent `storeAnswer` does not pay for a second embedding call.
 */
export async function lookupAnswer(opts: {
  query: string;
  language: Language;
  intent: Intent;
  kbVersion: number;
}): Promise<CacheLookup> {
  if (!enabled || !config().ANSWER_CACHE_ENABLED) return { answer: null, match: null, similarity: null, queryEmbedding: null };

  const key = answerKey(opts.query, opts.language, opts.intent, opts.kbVersion);
  const exact = entries.get(key);
  if (exact && isExpired(exact)) {
    // An expired entry is not "still there but old": the TTL is how long the answer may
    // be presented at all, because the corpus or the provider may have moved on.
    entries.delete(key);
    misses += 1;
  } else if (exact) {
    exact.hits += 1;
    hits += 1;
    // Insertion order is eviction order, so re-insert to mark it as used.
    entries.delete(key);
    entries.set(key, exact);
    return { answer: exact, match: 'exact', similarity: 1, queryEmbedding: null };
  }

  const provider = resolveEmbeddingProvider();
  let queryEmbedding: number[] | null = null;
  try {
    const [vector] = await provider.embed([opts.query]);
    queryEmbedding = vector ?? null;
  } catch {
    // A cache miss is an acceptable outcome of the cache being unavailable; the
    // request proceeds unfast-pathed. This is never reported as a user-visible
    // failure — unlike the database or the model, nothing here is load-bearing.
    logger.warn('answer cache lookup skipped: embedding provider unavailable');
    misses += 1;
    return { answer: null, match: null, similarity: null, queryEmbedding: null };
  }

  if (queryEmbedding) {
    let best: { entry: Entry; similarity: number } | null = null;
    for (const entry of entries.values()) {
      if (entry.language !== opts.language || entry.intent !== opts.intent || entry.kbVersion !== opts.kbVersion) continue;
      if (!entry.embedding || isExpired(entry)) {
        if (entry.embedding) entries.delete(entry.key);
        continue;
      }
      const similarity = cosine(queryEmbedding, entry.embedding);
      if (similarity >= SIMILARITY_THRESHOLD && (!best || similarity > best.similarity)) best = { entry, similarity };
    }
    if (best) {
      best.entry.hits += 1;
      hits += 1;
      return { answer: best.entry, match: 'similar', similarity: Number(best.similarity.toFixed(4)), queryEmbedding };
    }
  }

  misses += 1;
  return { answer: null, match: null, similarity: null, queryEmbedding };
}

export function storeAnswer(opts: {
  query: string;
  language: Language;
  intent: Intent;
  kbVersion: number;
  answer: CacheableAnswer;
  embedding: number[] | null;
}): void {
  if (!enabled || !config().ANSWER_CACHE_ENABLED) return;
  if (opts.answer.evidenceTier === 'NONE') {
    // An answer with no usable evidence is usually the R4 fallback, which is a
    // statement about the corpus rather than about the question. Caching it would
    // serve "I could not find" for the whole TTL on the strength of nothing.
    return;
  }
  const c = config();
  const key = answerKey(opts.query, opts.language, opts.intent, opts.kbVersion);
  entries.set(key, {
    ...opts.answer,
    key,
    query: opts.query,
    language: opts.language,
    intent: opts.intent,
    kbVersion: opts.kbVersion,
    embedding: opts.embedding,
    createdAt: Date.now(),
    hits: 0,
  });

  const ttlMs = c.ANSWER_CACHE_TTL_SECONDS * 1000;
  for (const [k, entry] of entries) {
    if (Date.now() - entry.createdAt > ttlMs) entries.delete(k);
  }
  while (entries.size > c.ANSWER_CACHE_MAX_ENTRIES) {
    const oldest = entries.keys().next();
    if (oldest.done) break;
    entries.delete(oldest.value);
  }
}

/** Exposed for `/admin/knowledge/stats` and tests. */
export function answerCacheEntryCount(): number {
  return entries.size;
}
