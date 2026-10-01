package in.bissaathi.domain;

import in.bissaathi.common.EvidenceTier;
import in.bissaathi.common.Intent;
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
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.annotations.UpdateTimestamp;
import org.hibernate.type.SqlTypes;

/**
 * A single turn in a conversation.
 *
 * `sourcesJson` is the FROZEN evidence set for this answer: the citation validator
 * already removed any reference the model invented (R3), so what is stored is
 * exactly what the user was shown. Re-deriving it later from the live knowledge base
 * would let a re-ingest silently rewrite history (R2).
 *
 * `userId` is denormalised from the conversation on purpose so that every message
 * query can be authorised by user_id alone (R9).
 */
@Entity
@Table(name = "messages")
public class MessageEntity {

  @Id
  @GeneratedValue
  @Column(name = "id", updatable = false, nullable = false)
  private UUID id;

  @Column(name = "conversation_id", nullable = false)
  private UUID conversationId;

  @Column(name = "user_id", nullable = false)
  private UUID userId;

  @Column(name = "role", nullable = false, length = 16)
  private String role;

  @Column(name = "content", nullable = false, columnDefinition = "text")
  private String content;

  @JdbcTypeCode(SqlTypes.JSON)
  @Column(name = "sources_json", nullable = false, columnDefinition = "jsonb")
  private String sourcesJson = "[]";

  @Enumerated(EnumType.STRING)
  @Column(name = "evidence_tier", nullable = false, length = 8)
  private EvidenceTier evidenceTier = EvidenceTier.NONE;

  @Enumerated(EnumType.STRING)
  @Column(name = "intent", length = 24)
  private Intent intent;

  @Enumerated(EnumType.STRING)
  @Column(name = "language", nullable = false, length = 8)
  private Language language = Language.en;

  @Column(name = "prompt_tokens", nullable = false)
  private int promptTokens = 0;

  @Column(name = "completion_tokens", nullable = false)
  private int completionTokens = 0;

  @Column(name = "model", length = 64)
  private String model;

  @Column(name = "cache_hit", nullable = false)
  private boolean cacheHit = false;

  @Column(name = "retrieval_ms")
  private Integer retrievalMs;

  @JdbcTypeCode(SqlTypes.JSON)
  @Column(name = "follow_ups", nullable = false, columnDefinition = "jsonb")
  private String followUps = "[]";

  /** R8: a failed generation is recorded here, never papered over. */
  @Column(name = "error", length = 64)
  private String error;

  @CreationTimestamp
  @Column(name = "created_at", nullable = false, updatable = false)
  private Instant createdAt;

  @UpdateTimestamp
  @Column(name = "updated_at", nullable = false)
  private Instant updatedAt;

  protected MessageEntity() {}

  public MessageEntity(UUID conversationId, UUID userId, String role, String content, Language language) {
    this.conversationId = conversationId;
    this.userId = userId;
    this.role = role;
    this.content = content;
    this.language = language;
  }

  public UUID getId() { return id; }
  public UUID getConversationId() { return conversationId; }
  public UUID getUserId() { return userId; }
  public String getRole() { return role; }
  public String getContent() { return content; }
  public String getSourcesJson() { return sourcesJson; }
  public EvidenceTier getEvidenceTier() { return evidenceTier; }
  public Intent getIntent() { return intent; }
  public Language getLanguage() { return language; }
  public int getPromptTokens() { return promptTokens; }
  public int getCompletionTokens() { return completionTokens; }
  public String getModel() { return model; }
  public boolean isCacheHit() { return cacheHit; }
  public Integer getRetrievalMs() { return retrievalMs; }
  public String getFollowUps() { return followUps; }
  public String getError() { return error; }
  public Instant getCreatedAt() { return createdAt; }

  public void setSourcesJson(String sourcesJson) { this.sourcesJson = sourcesJson; }
  public void setEvidenceTier(EvidenceTier evidenceTier) { this.evidenceTier = evidenceTier; }
  public void setIntent(Intent intent) { this.intent = intent; }
  public void setUsage(int promptTokens, int completionTokens, String model) {
    this.promptTokens = promptTokens;
    this.completionTokens = completionTokens;
    this.model = model;
  }
  public void setCacheHit(boolean cacheHit) { this.cacheHit = cacheHit; }
  public void setRetrievalMs(Integer retrievalMs) { this.retrievalMs = retrievalMs; }
  public void setFollowUps(String followUps) { this.followUps = followUps; }
  public void setError(String error) { this.error = error; }
}
