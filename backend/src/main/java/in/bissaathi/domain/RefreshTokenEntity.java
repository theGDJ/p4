package in.bissaathi.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;
import org.hibernate.annotations.CreationTimestamp;

/**
 * A rotating refresh token (§8).
 *
 * Append-only and never updated in place except to record use or revocation: the
 * row is the evidence that reuse detection depends on. Only the SHA-256 hash of the
 * token is stored, so a database read does not yield usable credentials.
 */
@Entity
@Table(name = "refresh_tokens")
public class RefreshTokenEntity {

  @Id
  @GeneratedValue
  @Column(name = "id", updatable = false, nullable = false)
  private UUID id;

  @Column(name = "user_id", nullable = false)
  private UUID userId;

  /** Groups a rotation chain. Reuse of any member revokes the whole family. */
  @Column(name = "family_id", nullable = false)
  private UUID familyId;

  @Column(name = "token_hash", nullable = false, length = 64, unique = true)
  private String tokenHash;

  @Column(name = "expires_at", nullable = false)
  private Instant expiresAt;

  @Column(name = "used_at")
  private Instant usedAt;

  @Column(name = "revoked_at")
  private Instant revokedAt;

  @Column(name = "replaced_by_token_id")
  private UUID replacedByTokenId;

  @Column(name = "user_agent", length = 512)
  private String userAgent;

  @Column(name = "ip", length = 45)
  private String ip;

  @CreationTimestamp
  @Column(name = "created_at", nullable = false, updatable = false)
  private Instant createdAt;

  protected RefreshTokenEntity() {}

  public RefreshTokenEntity(UUID userId, UUID familyId, String tokenHash, Instant expiresAt, String userAgent, String ip) {
    this.userId = userId;
    this.familyId = familyId;
    this.tokenHash = tokenHash;
    this.expiresAt = expiresAt;
    this.userAgent = userAgent;
    this.ip = ip;
  }

  public boolean isActive(Instant now) {
    return usedAt == null && revokedAt == null && expiresAt.isAfter(now);
  }

  /** True when the token was already spent — presenting it again is theft. */
  public boolean isUsed() {
    return usedAt != null;
  }

  public void markUsed(Instant now, UUID replacedBy) {
    this.usedAt = now;
    this.replacedByTokenId = replacedBy;
  }

  public void revoke(Instant now) {
    if (this.revokedAt == null) this.revokedAt = now;
  }

  public UUID getId() { return id; }
  public UUID getUserId() { return userId; }
  public UUID getFamilyId() { return familyId; }
  public String getTokenHash() { return tokenHash; }
  public Instant getExpiresAt() { return expiresAt; }
  public Instant getUsedAt() { return usedAt; }
  public Instant getRevokedAt() { return revokedAt; }
  public UUID getReplacedByTokenId() { return replacedByTokenId; }
}
