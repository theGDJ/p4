package in.bissaathi.domain;

import in.bissaathi.common.Language;
import in.bissaathi.common.VerificationStatus;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import java.time.LocalDate;
import java.util.UUID;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.annotations.UpdateTimestamp;
import org.hibernate.type.SqlTypes;

/**
 * The retrieval unit (§7, feature #11).
 *
 * The `embedding vector(1024)` column is deliberately NOT mapped here. Vector reads
 * and writes go through native SQL in RetrievalService, which keeps a separately
 * versioned pgvector Java driver out of the build and makes the dimension contract
 * explicit at the call site instead of implicit in a type converter.
 *
 * A chunk is retrievable only when reviewState = APPROVED and verificationStatus is
 * not SUPERSEDED (R7). `restricted` is forbidden by a database CHECK, so restricted
 * standards can only ever be metadata (R11).
 */
@Entity
@Table(name = "knowledge_chunks")
public class KnowledgeChunkEntity {

  @Id
  @GeneratedValue
  @Column(name = "id", updatable = false, nullable = false)
  private UUID id;

  @Column(name = "document_id", nullable = false)
  private UUID documentId;

  @Column(name = "document_version_id", nullable = false)
  private UUID documentVersionId;

  @Column(name = "ordinal", nullable = false)
  private int ordinal;

  @Column(name = "title", nullable = false, columnDefinition = "text")
  private String title;

  @Column(name = "standard_no", length = 64)
  private String standardNo;

  @Column(name = "section", length = 120)
  private String section;

  @Column(name = "heading_path", columnDefinition = "text")
  private String headingPath;

  @Column(name = "doc_type", nullable = false, length = 32)
  private String docType = "OTHER";

  @Enumerated(EnumType.STRING)
  @Column(name = "language", nullable = false, length = 8)
  private Language language = Language.en;

  @Column(name = "source_url", columnDefinition = "text")
  private String sourceUrl;

  @Column(name = "published_date")
  private LocalDate publishedDate;

  @Column(name = "revised_date")
  private LocalDate revisedDate;

  @Enumerated(EnumType.STRING)
  @Column(name = "verification_status", nullable = false, length = 24)
  private VerificationStatus verificationStatus = VerificationStatus.UNVERIFIED;

  @Column(name = "verified_by")
  private UUID verifiedBy;

  @Column(name = "verified_at")
  private Instant verifiedAt;

  @Column(name = "review_state", nullable = false, length = 24)
  private String reviewState = "PENDING_REVIEW";

  @Column(name = "reviewed_by")
  private UUID reviewedBy;

  @Column(name = "reviewed_at")
  private Instant reviewedAt;

  @Column(name = "content", nullable = false, columnDefinition = "text")
  private String content;

  @Column(name = "content_hash", nullable = false, length = 64)
  private String contentHash;

  @Column(name = "token_count", nullable = false)
  private int tokenCount = 0;

  @Column(name = "embedding_model", length = 64)
  private String embeddingModel;

  @Column(name = "embedded_at")
  private Instant embeddedAt;

  @JdbcTypeCode(SqlTypes.JSON)
  @Column(name = "metadata", nullable = false, columnDefinition = "jsonb")
  private String metadata = "{}";

  @Column(name = "ingested_at", nullable = false)
  private Instant ingestedAt = Instant.now();

  @CreationTimestamp
  @Column(name = "created_at", nullable = false, updatable = false)
  private Instant createdAt;

  @UpdateTimestamp
  @Column(name = "updated_at", nullable = false)
  private Instant updatedAt;

  protected KnowledgeChunkEntity() {}

  /** R7: the single definition of "may this chunk be retrieved". */
  public boolean isRetrievable() {
    return "APPROVED".equals(reviewState) && verificationStatus != VerificationStatus.SUPERSEDED;
  }

  public UUID getId() { return id; }
  public UUID getDocumentId() { return documentId; }
  public UUID getDocumentVersionId() { return documentVersionId; }
  public int getOrdinal() { return ordinal; }
  public String getTitle() { return title; }
  public String getStandardNo() { return standardNo; }
  public String getSection() { return section; }
  public String getHeadingPath() { return headingPath; }
  public String getDocType() { return docType; }
  public Language getLanguage() { return language; }
  public String getSourceUrl() { return sourceUrl; }
  public LocalDate getPublishedDate() { return publishedDate; }
  public LocalDate getRevisedDate() { return revisedDate; }
  public VerificationStatus getVerificationStatus() { return verificationStatus; }
  public Instant getVerifiedAt() { return verifiedAt; }
  public String getReviewState() { return reviewState; }
  public String getContent() { return content; }
  public String getContentHash() { return contentHash; }
  public int getTokenCount() { return tokenCount; }
  public String getEmbeddingModel() { return embeddingModel; }
  public String getMetadata() { return metadata; }

  public void setReviewState(String reviewState, UUID reviewedBy, Instant reviewedAt) {
    this.reviewState = reviewState;
    this.reviewedBy = reviewedBy;
    this.reviewedAt = reviewedAt;
  }

  public void setVerification(VerificationStatus status, UUID verifiedBy, Instant verifiedAt) {
    this.verificationStatus = status;
    this.verifiedBy = verifiedBy;
    this.verifiedAt = verifiedAt;
  }
}
