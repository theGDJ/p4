package in.bissaathi.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;
import org.hibernate.annotations.CreationTimestamp;

/** Opaque, single-use, hashed, short-lived password reset token (§8). */
@Entity
@Table(name = "password_reset_tokens")
public class PasswordResetTokenEntity {

  @Id
  @GeneratedValue
  @Column(name = "id", updatable = false, nullable = false)
  private UUID id;

  @Column(name = "user_id", nullable = false)
  private UUID userId;

  @Column(name = "token_hash", nullable = false, length = 64, unique = true)
  private String tokenHash;

  @Column(name = "expires_at", nullable = false)
  private Instant expiresAt;

  @Column(name = "used_at")
  private Instant usedAt;

  @Column(name = "ip", length = 45)
  private String ip;

  @CreationTimestamp
  @Column(name = "created_at", nullable = false, updatable = false)
  private Instant createdAt;

  protected PasswordResetTokenEntity() {}

  public PasswordResetTokenEntity(UUID userId, String tokenHash, Instant expiresAt, String ip) {
    this.userId = userId;
    this.tokenHash = tokenHash;
    this.expiresAt = expiresAt;
    this.ip = ip;
  }

  public boolean isUsable(Instant now) {
    return usedAt == null && expiresAt.isAfter(now);
  }

  public void markUsed(Instant now) {
    this.usedAt = now;
  }

  public UUID getId() { return id; }
  public UUID getUserId() { return userId; }
  public String getTokenHash() { return tokenHash; }
}
