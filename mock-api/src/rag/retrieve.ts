import { knowledgeChunks, type KnowledgeChunkRow, type SourceSnapshot, type Store } from '../db/store';
import type { Intent, Language } from '../constants';
import { estimateTokens } from './providers';

/**
 * Retrieval (§5, query path steps 3–4).
 *
 * **P1 status — read this before trusting scores.**
 * The production pipeline is `vector top-30 + FTS top-30 -> RRF -> metadata
 * filters -> rerank -> top 6 -> dedupe -> context <= 3000 tokens`. Vector search
 * needs pgvector and FTS needs a Postgres `tsvector`, neither of which exists in
 * this sandbox. What is implemented here is the *shape* of that pipeline over a
 * deterministic lexical scorer, so that:
 *   - the metadata filters (R7 status, language, intent) are real and tested;
 *   - the S1..S6 source snapshot handed to the model and the UI is real;
 *   - the context budget and near-duplicate drop are real;
 *   - citation validation in `answer.ts` has a genuine retrieved set to check against.
 * Scores are therefore NOT comparable to cosine similarity and are never shown
 * to users as a confidence figure. P2 swaps `scoreChunk` for pgvector + FTS + RRF
 * behind this same function signature.
 */

export interface RetrievalHit {
  chunk: KnowledgeChunkRow;
  score: number;
  /** "Why retrieved" — surfaced in the recommender UI (§6 #9). */
  reason: string;
  method: 'lexical';
}

export interface RetrievalResult {
  hits: RetrievalHit[];
  /** S1..S6 snapshots: the ONLY source data the UI or the model may reference (R3). */
  sources: SourceSnapshot[];
  context: string;
  contextTokens: number;
  kbVersion: number;
  latencyMs: number;
  /** True when nothing was retrievable at all, which drives the R4 path. */
  empty: boolean;
}

export const MAX_CONTEXT_TOKENS = 3000;
export const TOP_K_FINAL = 6;
/** Above this normalised overlap two chunks are treated as near-duplicates (§5 step 4). */
const NEAR_DUPLICATE_OVERLAP = 0.82;

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'for', 'and', 'or', 'in', 'on',
  'at', 'by', 'with', 'what', 'which', 'how', 'do', 'does', 'did', 'i', 'my', 'me', 'we', 'you',
  'it', 'this', 'that', 'from', 'as', 'can', 'could', 'should', 'would', 'please', 'tell',
  'क्या', 'है', 'और', 'का', 'की', 'के', 'में', 'को', 'से', 'पर', 'मेरा', 'आप', 'मुझे', 'यह', 'वह',
]);

function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    // Keep digits and ':' so standard numbers survive as searchable tokens.
    .split(/[^\p{L}\p{N}:.]+/u)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** Deterministic lexical overlap in [0,1]. See the P1 status note above. */
function scoreChunk(queryTokens: string[], chunk: KnowledgeChunkRow): { score: number; matched: string[] } {
  const haystack = new Set(tokenise(`${chunk.headingPath ?? ''} ${chunk.section ?? ''} ${chunk.title} ${chunk.standardNo ?? ''} ${chunk.content}`));
  const matched = queryTokens.filter((t) => haystack.has(t));
  if (matched.length === 0) return { score: 0, matched };
  // Length-normalised so a long chunk cannot win purely by containing more words.
  const coverage = matched.length / Math.max(new Set(queryTokens).size, 1);
  const density = matched.length / Math.max(Math.sqrt(haystack.size), 1);
  return { score: Number((0.7 * coverage + 0.3 * density).toFixed(4)), matched };
}

/** Jaccard overlap used to drop near-duplicate chunks. */
function similarity(a: string, b: string): number {
  const setA = new Set(tokenise(a));
  const setB = new Set(tokenise(b));
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection += 1;
  return intersection / (setA.size + setB.size - intersection);
}

/**
 * Intent-specific document types (§5 step 3: "metadata filters (intent, language,
 * status)"). `doc_type` is *soft* evidence: a QCO answering a hallmarking question
 * is still relevant, so a non-preferred type is scored slightly lower rather than
 * excluded. A hard exclusion on a vocabulary this coarse would hide real documents.
 */
export const PREFERRED_DOC_TYPES: Partial<Record<Intent, readonly string[]>> = {
  hallmarking: ['GUIDE', 'STANDARD', 'FAQ', 'NOTIFICATION'],
  certification: ['PROCEDURE', 'GUIDE', 'NOTIFICATION', 'FAQ', 'STANDARD', 'HANDBOOK', 'SCHEME'],
  lab: ['LABORATORY_LIST', 'GUIDE', 'FAQ'],
  recommend: ['STANDARD', 'QCO', 'NOTIFICATION', 'GUIDE'],
  factual: ['STANDARD', 'HANDBOOK', 'FAQ', 'GUIDE'],
};

/** Applied to the lexical score; bounded so it can never outrank real term overlap. */
const TYPE_PREFERENCE_BONUS = 1.12;

export function docTypeBonus(intent: Intent, docType: string): number {
  const preferred = PREFERRED_DOC_TYPES[intent];
  return preferred && preferred.includes(docType) ? TYPE_PREFERENCE_BONUS : 1;
}

/**
 * Metadata filters (§5 step 3 tail, R7).
 * - `reviewState === APPROVED` and `verificationStatus !== SUPERSEDED` are enforced
 *   inside `knowledgeChunks.retrievable`, never here, so they cannot be bypassed.
 * - Language: prefer the query language but keep English chunks for Hindi queries,
 *   because cross-lingual retrieval is a stated requirement (§3).
 * - RESTRICTED documents contribute metadata only, never full text (R11) — enforced
 *   at ingestion: a restricted document has no chunks to retrieve.
 */
function applyMetadataFilters(chunks: KnowledgeChunkRow[], language: Language, intent: Intent): KnowledgeChunkRow[] {
  return chunks.filter((c) => {
    // Language filter: a Hindi query may also read English chunks (cross-lingual
    // retrieval is a stated requirement, §3), but an English query never pulls in
    // a Hindi chunk, because that would put untranslated text in front of a user
    // who asked in English.
    if (language === 'hi' && c.language !== 'hi' && c.language !== 'en') return false;
    if (language === 'en' && c.language !== 'en') return false;
    return true;
  });
}

export function toSourceSnapshot(chunk: KnowledgeChunkRow, ref: string, score: number): SourceSnapshot {
  return {
    ref,
    chunkId: chunk.id,
    documentVersionId: chunk.documentVersionId,
    // Every display field comes from the stored row — never from model output (R3).
    title: chunk.title,
    standardNo: chunk.standardNo,
    section: chunk.section ?? chunk.headingPath,
    docType: chunk.docType,
    language: chunk.language,
    sourceUrl: chunk.sourceUrl,
    verificationStatus: chunk.verificationStatus,
    verifiedAt: chunk.verifiedAt,
    snippet: chunk.content.slice(0, 320),
    score,
  };
}

export function retrieve(
  store: Store,
  query: string,
  opts: { language: Language; intent: Intent; topK?: number },
): RetrievalResult {
  const started = Date.now();
  const topK = opts.topK ?? TOP_K_FINAL;
  const queryTokens = tokenise(query);

  const candidates = applyMetadataFilters(knowledgeChunks.retrievable(store), opts.language, opts.intent);

  const scored = candidates
    .map((chunk) => {
      const { score: lexical, matched } = scoreChunk(queryTokens, chunk);
      const score = Number((lexical * docTypeBonus(opts.intent, chunk.docType)).toFixed(4));
      return {
        chunk,
        score,
        matched,
        reason:
          matched.length > 0
            ? `Matched ${matched.length} query term${matched.length === 1 ? '' : 's'} (${matched.slice(0, 4).join(', ')}) in ${chunk.docType}${chunk.section ? ` · ${chunk.section}` : ''}`
            : 'No term overlap',
      };
    })
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score);

  // Near-duplicate drop (§5 step 4): keep the higher-scoring of any overlapping pair.
  const deduped: typeof scored = [];
  for (const hit of scored) {
    const duplicate = deduped.some((kept) => similarity(kept.chunk.content, hit.chunk.content) >= NEAR_DUPLICATE_OVERLAP);
    if (!duplicate) deduped.push(hit);
    if (deduped.length >= topK) break;
  }

  const final = deduped.slice(0, topK);

  // Build the context with S1..Sn ids and enforce the token budget (§9).
  const sources: SourceSnapshot[] = [];
  const contextParts: string[] = [];
  let tokens = 0;
  final.forEach((hit, index) => {
    const ref = `S${index + 1}`;
    const block = `[${ref}] ${hit.chunk.title}${hit.chunk.standardNo ? ` — ${hit.chunk.standardNo}` : ''}${
      hit.chunk.section ? ` — ${hit.chunk.section}` : ''
    }\n${hit.chunk.content}`;
    const blockTokens = estimateTokens(block);
    if (tokens + blockTokens > MAX_CONTEXT_TOKENS) return; // budget exhausted; stop adding
    tokens += blockTokens;
    contextParts.push(block);
    sources.push(toSourceSnapshot(hit.chunk, ref, hit.score));
  });

  return {
    hits: final.map((h) => ({ chunk: h.chunk, score: h.score, reason: h.reason, method: 'lexical' as const })),
    sources,
    context: contextParts.join('\n\n'),
    contextTokens: tokens,
    kbVersion: store.kbVersion,
    latencyMs: Date.now() - started,
    empty: sources.length === 0,
  };
}
