package in.bissaathi.domain;

import in.bissaathi.common.Language;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.UpdateTimestamp;

/** A conversation. Always owned by exactly one user; never shared (R9). */
@Entity
@Table(name = "conversations")
public class ConversationEntity {

  @Id
  @GeneratedValue
  @Column(name = "id", updatable = false, nullable = false)
  private UUID id;

  @Column(name = "user_id", nullable = false)
  private UUID userId;

  @Column(name = "title", nullable = false, length = 160)
  private String title;

  @Column(name = "summary", columnDefinition = "text")
  private String summary;

  @Enumerated(EnumType.STRING)
  @Column(name = "language", nullable = false, length = 8)
  private Language language = Language.en;

  @Column(name = "archived_at")
  private Instant archivedAt;

  @CreationTimestamp
  @Column(name = "created_at", nullable = false, updatable = false)
  private Instant createdAt;

  @UpdateTimestamp
  @Column(name = "updated_at", nullable = false)
  private Instant updatedAt;

  protected ConversationEntity() {}

  public ConversationEntity(UUID userId, String title, Language language) {
    this.userId = userId;
    this.title = title;
    this.language = language;
  }

  public UUID getId() { return id; }
  public UUID getUserId() { return userId; }
  public String getTitle() { return title; }
  public String getSummary() { return summary; }
  public Language getLanguage() { return language; }
  public Instant getArchivedAt() { return archivedAt; }
  public Instant getCreatedAt() { return createdAt; }
  public Instant getUpdatedAt() { return updatedAt; }

  public void setTitle(String title) { this.title = title; }
  public void setSummary(String summary) { this.summary = summary; }
  public void setArchivedAt(Instant archivedAt) { this.archivedAt = archivedAt; }
}
