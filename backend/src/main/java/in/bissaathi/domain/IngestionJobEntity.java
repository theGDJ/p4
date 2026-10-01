package in.bissaathi.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.UpdateTimestamp;

/**
 * One ingestion attempt (§7, feature #11).
 *
 * State is a string rather than an enum column so a new pipeline stage does not
 * require a migration, and `error` keeps the failure reason: a job that died and
 * reported success would make the whole knowledge base unverifiable (R8).
 */
@Entity
@Table(name = "ingestion_jobs")
public class IngestionJobEntity {

  @Id
  @GeneratedValue
  @Column(name = "id", updatable = false, nullable = false)
  private UUID id;

  @Column(name = "document_id")
  private UUID documentId;

  @Column(name = "source_kind", nullable = false, length = 32)
  private String sourceKind = "url";

  @Column(name = "state", nullable = false, length = 16)
  private String state = "PENDING";

  @Column(name = "stage", nullable = false, length = 32)
  private String stage = "QUEUED";

  @Column(name = "error", columnDefinition = "text")
  private String error;

  @Column(name = "attempts", nullable = false)
  private short attempts = 0;

  @Column(name = "chunks_produced", nullable = false)
  private int chunksProduced = 0;

  @Column(name = "requested_by")
  private UUID requestedBy;

  @Column(name = "started_at")
  private Instant startedAt;

  @Column(name = "finished_at")
  private Instant finishedAt;

  @CreationTimestamp
  @Column(name = "created_at", nullable = false, updatable = false)
  private Instant createdAt;

  @UpdateTimestamp
  @Column(name = "updated_at", nullable = false)
  private Instant updatedAt;

  protected IngestionJobEntity() {}

  public UUID getId() { return id; }
  public UUID getDocumentId() { return documentId; }
  public String getSourceKind() { return sourceKind; }
  public String getState() { return state; }
  public String getStage() { return stage; }
  public String getError() { return error; }
  public short getAttempts() { return attempts; }
  public int getChunksProduced() { return chunksProduced; }
  public UUID getRequestedBy() { return requestedBy; }
  public Instant getCreatedAt() { return createdAt; }
  public Instant getUpdatedAt() { return updatedAt; }
}
