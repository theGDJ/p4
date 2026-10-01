package in.bissaathi.common;

import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import java.util.List;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;
import org.springframework.validation.annotation.Validated;

/**
 * Everything configurable about the application, bound from {@code bissaathi.*}.
 *
 * Records rather than mutable beans: a property cannot be changed at runtime by a
 * stray setter, which matters for the security-relevant ones (TTLs, lockout
 * thresholds, cookie flags).
 */
@Validated
@ConfigurationProperties(prefix = "bissaathi")
public record AppProperties(
    @NotNull Cors cors,
    @NotNull Jwt jwt,
    @NotNull Refresh refresh,
    @NotNull Password password,
    @NotNull Lockout lockout,
    @NotNull RateLimit rateLimit,
    @NotNull Csrf csrf,
    @NotNull Rag rag,
    @NotNull Answers answers,
    @NotNull Seed seed) {

  public record Cors(@NotNull List<@NotBlank String> allowedOrigins) {}

  public record Jwt(
      @NotBlank String secret,
      @Min(1) int accessTtlMinutes,
      @NotBlank String issuer,
      @NotBlank String audience) {}

  public record Refresh(
      @Min(1) int ttlDays,
      @NotBlank String cookieName,
      @NotBlank String cookiePath,
      boolean secure,
      @NotBlank String sameSite) {}

  public record Password(
      @Min(8) int minLength,
      @Min(16) int maxLength,
      @NotBlank String scheme,
      @NotNull Argon2 argon2,
      @Min(10) int bcryptStrength,
      @Min(1) int resetTokenTtlMinutes) {

    public record Argon2(@Min(1024) int memoryKib, @Min(1) int iterations, @Min(1) int parallelism) {}
  }

  public record Lockout(@Min(1) int maxFailedAttempts, @Min(1) int lockMinutes) {}

  public record RateLimit(
      boolean enabled,
      @Min(1) int authMax,
      @Min(1) int authWindowSeconds,
      @Min(1) int chatMax,
      @Min(1) int chatWindowSeconds) {}

  public record Csrf(boolean enabled, @NotBlank String cookieName, @NotBlank String headerName) {}

  public record Rag(
      @NotBlank String llmProvider,
      @NotBlank String embeddingProvider,
      @Min(1) int embeddingDimensions,
      @Min(1) int topKVector,
      @Min(1) int topKFts,
      @Min(1) int maxContextChunks,
      @Min(1) int maxContextTokens,
      double evidenceScoreThreshold,
      double dedupeJaccardThreshold,
      double temperature,
      @Min(0) int maxFollowUps) {

    /** True when no real model is wired up. The UI must badge this (R8/R10). */
    public boolean isMockLlm() {
      return "mock".equalsIgnoreCase(llmProvider);
    }

    public boolean isMockEmbedding() {
      return "mock".equalsIgnoreCase(embeddingProvider);
    }
  }

  /** Contractual answer strings (R4/R5). Tests assert these verbatim. */
  public record Answers(
      @NotBlank String insufficientEvidenceEn,
      @NotBlank String insufficientEvidenceHi,
      @NotBlank String disclaimerEn,
      @NotBlank String disclaimerHi) {

    public String insufficientEvidence(Language language) {
      return language == Language.hi ? insufficientEvidenceHi : insufficientEvidenceEn;
    }

    public String disclaimer(Language language) {
      return language == Language.hi ? disclaimerHi : disclaimerEn;
    }
  }

  public record Seed(boolean enabled, String password) {}

  /** Convenience for the values the bootstrap endpoint publishes to the client. */
  public List<String> personas() {
    return List.of("CONSUMER", "MSME_MANUFACTURER", "JEWELLER_RETAILER", "STUDENT_ENGINEER");
  }

  public List<String> languages() {
    return List.of(Language.en.name(), Language.hi.name());
  }
}
