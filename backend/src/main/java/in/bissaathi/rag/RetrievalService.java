package in.bissaathi.rag;

import in.bissaathi.common.AppProperties;
import in.bissaathi.common.Language;
import in.bissaathi.domain.KnowledgeChunkEntity;
import in.bissaathi.repo.KnowledgeChunkRepository;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Hybrid retrieval: vector candidates + Postgres FTS candidates, fused by reciprocal
 * rank fusion, then filtered, reranked, truncated and deduplicated (§6).
 *
 * Two honest caveats, both load-bearing:
 *
 *  1. The RRF score is a rank-fusion score, NOT a cosine similarity. It is compared
 *     against evidence-score-threshold to decide the evidence tier, which is only
 *     meaningful once the vector half is live. Until then, the FTS-only path produces
 *     scores in a different range, so a "STRONG" tier from this service in a
 *     mock-embedding deployment would be a fabrication. The zero-vector provider
 *     guarantees the vector half contributes nothing, which is the correct behaviour.
 *  2. Nothing here re-checks approvability for the vector query beyond the SQL WHERE
 *     clause. R7 is enforced in the query itself, not in a filter that could be
 *     removed.
 */
@Service
public class RetrievalService {

  private static final Logger log = LoggerFactory.getLogger(RetrievalService.class);
  private static final int RRF_K = 60;

  private final KnowledgeChunkRepository chunks;
  private final JdbcTemplate jdbc;
  private final EmbeddingProvider embeddings;
  private final AppProperties properties;

  public RetrievalService(
      KnowledgeChunkRepository chunks, JdbcTemplate jdbc, EmbeddingProvider embeddings, AppProperties properties) {
    this.chunks = chunks;
    this.jdbc = jdbc;
    this.embeddings = embeddings;
    this.properties = properties;
  }

  public record Outcome(List<RetrievedChunk> chunks, long elapsedMillis, int vectorCandidates, int ftsCandidates) {}

  @Transactional(readOnly = true)
  public Outcome retrieve(String question, Language language) {
    long startedAt = System.nanoTime();
    AppProperties.Rag rag = properties.rag();

    List<String> vectorIds = rag.isMockEmbedding() ? List.of() : vectorCandidates(question, rag.topKVector());
    List<String> ftsIds = ftsCandidates(question, rag.topKFts());

    Map<String, Double> fused = reciprocalRankFusion(vectorIds, ftsIds);
    if (fused.isEmpty()) {
      return new Outcome(List.of(), millisSince(startedAt), vectorIds.size(), ftsIds.size());
    }

    // Load by id, then apply the retrievability predicate a second time in memory.
    // The SQL already filters, so this is defence in depth: a chunk that somehow
    // became unapproved between the candidate query and the load must not be cited.
    List<KnowledgeChunkEntity> rows = chunks.findAllById(
        fused.keySet().stream().map(java.util.UUID::fromString).toList());
    List<RetrievedChunk> usable = new ArrayList<>();
    for (KnowledgeChunkEntity row : rows) {
      if (!row.isRetrievable()) continue;
      if (language != null && row.getLanguage() != language) continue;
      usable.add(
          new RetrievedChunk(
              row.getId().toString(),
              row.getDocumentVersionId().toString(),
              row.getTitle(),
              row.getStandardNo(),
              row.getSection(),
              row.getDocType(),
              row.getLanguage(),
              row.getSourceUrl(),
              row.getVerificationStatus(),
              row.getVerifiedAt(),
              row.getContent(),
              fused.getOrDefault(row.getId().toString(), 0.0)));
    }

    usable.sort(Comparator.comparingDouble(RetrievedChunk::score).reversed());
    List<RetrievedChunk> deduped = dedupe(usable, rag.dedupeJaccardThreshold());
    List<RetrievedChunk> truncated = truncateToTokenBudget(deduped, rag.maxContextChunks(), rag.maxContextTokens());

    long elapsed = millisSince(startedAt);
    log.debug(
        "retrieval vector={} fts={} fused={} usable={} kept={} ms={}",
        vectorIds.size(),
        ftsIds.size(),
        fused.size(),
        usable.size(),
        truncated.size(),
        elapsed);
    return new Outcome(truncated, elapsed, vectorIds.size(), ftsIds.size());
  }

  /* ------------------------------------------------------------------ candidates */

  /**
   * Vector half. Native SQL because the embedding column is not a mapped JPA
   * attribute (see KnowledgeChunkEntity).
   *
   * HNSW's ef_search is set per statement rather than globally so a retrieval query
   * cannot silently change the recall/latency trade-off of every other query.
   */
  private List<String> vectorCandidates(String question, int limit) {
    float[] vector = embeddings.embed(question);
    String literal = toVectorLiteral(vector);
    return jdbc.queryForList(
            """
            select c.id::text from knowledge_chunks c
            where c.review_state = 'APPROVED'
              and c.verification_status <> 'SUPERSEDED'
              and c.embedding is not null
            order by c.embedding <=> ?::vector
            limit ?
            """,
            String.class,
            literal,
            limit)
        .stream()
        .map(String.class::cast)
        .toList();
  }

  private List<String> ftsCandidates(String question, int limit) {
    try {
      return chunks.fullTextCandidates(question, limit).stream()
          .map(row -> row.getId().toString())
          .toList();
    } catch (RuntimeException e) {
      // plainto_tsquery tolerates almost anything, so a failure here means the
      // database is unhealthy. Report it; do not return an empty list and let the
      // caller conclude the knowledge base simply has nothing (R8).
      log.error("full-text retrieval failed", e);
      throw e;
    }
  }

  /* ------------------------------------------------------------------------ fusion */

  /** RRF: score = Σ 1 / (k + rank). Rank-based, so two incomparable score scales
   *  cannot corrupt each other, which is exactly why it is used here. */
  private Map<String, Double> reciprocalRankFusion(List<String> vectorIds, List<String> ftsIds) {
    Map<String, Double> scores = new LinkedHashMap<>();
    addRanks(scores, vectorIds);
    addRanks(scores, ftsIds);
    return scores;
  }

  private static void addRanks(Map<String, Double> scores, List<String> ids) {
    for (int rank = 0; rank < ids.size(); rank++) {
      scores.merge(ids.get(rank), 1.0 / (RRF_K + rank + 1), Double::sum);
    }
  }

  /* ------------------------------------------------------------------- dedupe/budget */

  /**
   * Near-duplicate removal by Jaccard overlap on word sets.
   *
   * Ingested BIS material repeats itself — the same clause appears in a standard, a
   * handbook and an FAQ. Citing it three times looks like three independent sources
   * and is not (R3: every claim maps to its source, and one source is one source).
   */
  private List<RetrievedChunk> dedupe(List<RetrievedChunk> ordered, double threshold) {
    List<RetrievedChunk> kept = new ArrayList<>();
    List<java.util.Set<String>> keptSets = new ArrayList<>();
    for (RetrievedChunk candidate : ordered) {
      java.util.Set<String> tokens = tokens(candidate.text());
      boolean duplicate = false;
      for (java.util.Set<String> existing : keptSets) {
        if (jaccard(tokens, existing) >= threshold) {
          duplicate = true;
          break;
        }
      }
      if (!duplicate) {
        kept.add(candidate);
        keptSets.add(tokens);
      }
    }
    return kept;
  }

  private static java.util.Set<String> tokens(String text) {
    if (text == null || text.isBlank()) return java.util.Set.of();
    return java.util.Arrays.stream(
            java.text.Normalizer.normalize(text, java.text.Normalizer.Form.NFC)
                .toLowerCase(java.util.Locale.ROOT)
                .split("[^\\p{L}\\p{N}]+"))
        .filter(token -> !token.isBlank())
        .collect(java.util.stream.Collectors.toUnmodifiableSet());
  }

  private static double jaccard(java.util.Set<String> a, java.util.Set<String> b) {
    if (a.isEmpty() || b.isEmpty()) return 0.0;
    int intersection = 0;
    for (String token : a) {
      if (b.contains(token)) intersection++;
    }
    int union = a.size() + b.size() - intersection;
    return union == 0 ? 0.0 : (double) intersection / union;
  }

  /** A ~4-character-per-token heuristic, deliberately not a real tokenizer: the
   *  budget is a guard rail on prompt size, and the token count returned by the
   *  provider is what is billed and recorded. */
  private List<RetrievedChunk> truncateToTokenBudget(List<RetrievedChunk> ordered, int maxChunks, int maxTokens) {
    List<RetrievedChunk> kept = new ArrayList<>();
    int used = 0;
    for (RetrievedChunk chunk : ordered) {
      int cost = Math.max(1, chunk.text() == null ? 0 : chunk.text().length() / 4);
      if (kept.size() >= maxChunks || used + cost > maxTokens) break;
      kept.add(chunk);
      used += cost;
    }
    return kept;
  }

  /* ------------------------------------------------------------------------- utils */

  private static String toVectorLiteral(float[] vector) {
    StringBuilder builder = new StringBuilder(vector.length * 8).append('[');
    for (int i = 0; i < vector.length; i++) {
      if (i > 0) builder.append(',');
      builder.append(vector[i]);
    }
    return builder.append(']').toString();
  }

  private static long millisSince(long startedAt) {
    return (System.nanoTime() - startedAt) / 1_000_000L;
  }
}
