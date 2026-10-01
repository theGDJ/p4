package in.bissaathi.repo;

import in.bissaathi.domain.KnowledgeChunkEntity;
import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

/**
 * Chunk access for the RAG module.
 *
 * The two candidate queries below are the relational half of hybrid retrieval. The
 * vector half cannot be expressed in JPQL (there is no mapped embedding attribute by
 * design), so it runs as native SQL in RetrievalService and is unioned with the FTS
 * result by reciprocal rank fusion.
 */
public interface KnowledgeChunkRepository extends JpaRepository<KnowledgeChunkEntity, UUID> {

  long countByReviewStateAndVerificationStatusNot(String reviewState, in.bissaathi.common.VerificationStatus excluded);

  /**
   * R7 encoded as a query: only APPROVED, non-SUPERSEDED chunks are ever returned.
   * A caller cannot forget the filter because there is no unfiltered finder.
   */
  @Query(
      "select c from KnowledgeChunkEntity c where c.reviewState = 'APPROVED' "
          + "and c.verificationStatus <> in.bissaathi.common.VerificationStatus.SUPERSEDED "
          + "and (:language is null or c.language = :language)")
  List<KnowledgeChunkEntity> findRetrievable(@Param("language") in.bissaathi.common.Language language);

  /**
   * Postgres full-text candidate set. `simple` config is used because the corpus is
   * bilingual and an English stemmer mangles Devanagari tokens.
   */
  @Query(
      value =
          """
          select kc.* from knowledge_chunks kc
          where kc.review_state = 'APPROVED'
            and kc.verification_status <> 'SUPERSEDED'
            and kc.tsv @@ plainto_tsquery('simple', :query)
          order by ts_rank_cd(kc.tsv, plainto_tsquery('simple', :query)) desc
          limit :limit
          """,
      nativeQuery = true)
  List<KnowledgeChunkEntity> fullTextCandidates(@Param("query") String query, @Param("limit") int limit);
}
