package in.bissaathi.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.annotations.UpdateTimestamp;
import org.hibernate.type.SqlTypes;

/**
 * A security-relevant event (§8, feature #15).
 *
 * Written for: authentication outcomes, token rotation and reuse, role changes,
 * every denied authorization check, knowledge approval, and password resets. Read
 * only by ADMIN. The actor's roles are snapshotted at write time because the
 * question "who was allowed to do this" is about then, not now.
 */
@Entity
@Table(name = "audit_logs")
public class AuditLogEntity {

  /** Outcome vocabulary, matching the API and the frontend types. */
  public static final String SUCCESS = "SUCCESS";
  public static final String DENIED = "DENIED";
  public static final String FAILURE = "FAILURE";

  @Id
  @GeneratedValue
  @Column(name = "id", updatable = false, nullable = false)
  private UUID id;

  @Column(name = "actor_user_id")
  private UUID actorUserId;

  @JdbcTypeCode(SqlTypes.JSON)
  @Column(name = "actor_roles", nullable = false, columnDefinition = "jsonb")
  private String actorRoles = "[]";

  @Column(name = "action", nullable = false, length = 64)
  private String action;

  @Column(name = "entity_type", length = 48)
  private String entityType;

  @Column(name = "entity_id", length = 64)
  private String entityId;

  @Column(name = "outcome", nullable = false, length = 16)
  private String outcome = SUCCESS;

  @Column(name = "ip", length = 45)
  private String ip;

  @Column(name = "user_agent", length = 512)
  private String userAgent;

  @Column(name = "trace_ref", length = 32)
  private String traceRef;

  @JdbcTypeCode(SqlTypes.JSON)
  @Column(name = "metadata", nullable = false, columnDefinition = "jsonb")
  private String metadata = "{}";

  @CreationTimestamp
  @Column(name = "created_at", nullable = false, updatable = false)
  private Instant createdAt;

  @UpdateTimestamp
  @Column(name = "updated_at", nullable = false)
  private Instant updatedAt;

  protected AuditLogEntity() {}

  public AuditLogEntity(
      UUID actorUserId,
      String actorRolesJson,
      String action,
      String entityType,
      String entityId,
      String outcome,
      String ip,
      String userAgent,
      String traceRef,
      String metadataJson) {
    this.actorUserId = actorUserId;
    this.actorRoles = actorRolesJson;
    this.action = action;
    this.entityType = entityType;
    this.entityId = entityId;
    this.outcome = outcome;
    this.ip = ip;
    this.userAgent = userAgent;
    this.traceRef = traceRef;
    if (metadataJson != null) this.metadata = metadataJson;
  }

  public UUID getId() { return id; }
  public UUID getActorUserId() { return actorUserId; }
  public String getActorRoles() { return actorRoles; }
  public String getAction() { return action; }
  public String getEntityType() { return entityType; }
  public String getEntityId() { return entityId; }
  public String getOutcome() { return outcome; }
  public String getTraceRef() { return traceRef; }
  public String getMetadata() { return metadata; }
  public Instant getCreatedAt() { return createdAt; }
}
