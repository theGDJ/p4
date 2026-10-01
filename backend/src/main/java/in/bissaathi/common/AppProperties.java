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
    @NotNull Ingestion ingestion,
    @NotNull Mail mail,
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

  /**
   * Base URL and key are per client. The embedding client may inherit the LLM's pair, so
   * an operator configures one endpoint for a gateway that serves both; leaving the
   * embedding pair empty is only legal when the LLM pair is complete.
   */
  public record Rag(
      @NotBlank String llmProvider,
      @NotBlank String embeddingProvider,
      String llmBaseUrl,
      String llmApiKey,
      String llmSmallModel,
      String llmLargeModel,
      Double llmPriceInputPerMtok,
      Double llmPriceOutputPerMtok,
      String embeddingBaseUrl,
      String embeddingApiKey,
      String embeddingModel,
      @Min(1) int embeddingDimensions,
      @Min(1) int topKVector,
      @Min(1) int topKFts,
      @Min(1) int maxContextChunks,
      @Min(1) int maxContextTokens,
      double evidenceScoreThreshold,
      double dedupeJaccardThreshold,
      double temperature,
      @Min(0) int maxFollowUps,
      @Min(0) int historyTurns,
      @Min(64) int summaryMaxTokens,
      @Min(1000) int llmTimeoutMillis,
      @Min(0) int llmMaxRetries,
      @Min(1000) int embeddingTimeoutMillis,
      @Min(0) int embeddingMaxRetries,
      @Min(1) int embeddingBatchSize) {

    /** True when no real model is wired up. The UI must badge this (R8/R10). */
    public boolean isMockLlm() {
      return "mock".equalsIgnoreCase(llmProvider);
    }

    public boolean isMockEmbedding() {
      return "mock".equalsIgnoreCase(embeddingProvider);
    }

    /** True when generation would actually reach a model, so readiness can say so. */
    public boolean llmConfigured() {
      return !isMockLlm() && hasText(llmBaseUrl) && hasText(llmApiKey);
    }

    public boolean embeddingConfigured() {
      return !isMockEmbedding()
          && (hasText(embeddingBaseUrl) || hasText(llmBaseUrl))
          && (hasText(embeddingApiKey) || hasText(llmApiKey));
    }

    /**
     * Cost accounting is only meaningful when a price is configured. Without one the
     * API returns a null cost, which the UI shows as "no cost data" rather than as
     * free (R10).
     */
    public boolean costAccounting() {
      return llmPriceInputPerMtok != null || llmPriceOutputPerMtok != null;
    }

    private static boolean hasText(String value) {
      return value != null && !value.isBlank();
    }
  }

  /**
   * Knowledge ingestion (§5). The limits here are what make an outbound fetch safe to
   * run unattended: a page that streams forever, a redirect chain that loops back at
   * an internal host, or a 2 GB "text file" all have to be refused rather than survived.
   *
   * {@code allowPrivateNetworks} is a test-only switch. In production it is a fatal
   * boot error (see {@code IngestionPropertiesValidator}), because turning it on is
   * the same as pointing the server at its own metadata service.
   */
  public record Ingestion(
      @Min(1024) long maxBytes,
      @Min(1000) int timeoutMillis,
      @Min(0) int maxRedirects,
      boolean allowPrivateNetworks,
      @NotBlank String userAgent,
      @Min(1) int maxPages,
      @Min(1) int chunkMinTokens,
      @Min(2) int chunkMaxTokens,
      double chunkOverlapRatio,
      @NotBlank String manifestPath,
      @NotBlank String uploadDir,
      @Min(1024) long uploadMaxBytes,
      @Min(1) int burstCapacity,
      @Min(1) int sustainedPerMinute) {

    /** Overlap in tokens, rounded down — the number the chunker actually applies. */
    public int overlapTokens() {
      return (int) Math.floor(chunkMaxTokens * chunkOverlapRatio);
    }
  }

  /**
   * Password-reset mail. {@code transport} is a real switch, not a label: with
   * {@code none} nothing is sent and the API says so, rather than telling the user to
   * check an inbox that will never receive anything (R8).
   */
  public record Mail(
      @NotBlank String transport,
      String url,
      String host,
      @Min(1) int port,
      boolean secure,
      String user,
      String pass,
      String from,
      @NotBlank String subjectPrefix,
      String publicUrl) {

    public boolean isSmtp() {
      return "smtp".equalsIgnoreCase(transport);
    }

    public boolean isNone() {
      return "none".equalsIgnoreCase(transport);
    }
  }

  /** Contractual answer strings (R4/R5). Tests assert these verbatim. */
  public record Answers(
      @NotBlank String insufficientEvidenceEn,
      @NotBlank String insufficientEvidenceHi,
      @NotBlank String disclaimerEn,
      @NotBlank String disclaimerHi,
      @NotNull Cache cache) {

    /**
     * The semantic answer cache (§9). Keys carry the knowledge-base version, so an
     * approval or rejection invalidates every answer that quoted the affected chunk.
     * The similarity floor is deliberately conservative: a near-miss match must return
     * a wrong answer in the worst case, and that is what the eval set measures.
     */
    public record Cache(
        boolean enabled,
        @Min(10) int ttlSeconds,
        @Min(1) int maxEntries,
        double similarity) {}

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
