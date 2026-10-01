package in.bissaathi.config;

import in.bissaathi.common.AppProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.ApplicationListener;
import org.springframework.context.event.ContextRefreshedEvent;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

/**
 * Refuses to boot when the P2 subsystems are configured in a way that cannot work —
 * or that works and quietly lies (§8, R8).
 *
 * <p>The pattern to avoid is a deployment that starts, looks healthy, and then fails on
 * the first real request: a provider named but not reachable, an SMTP transport with no
 * host, a chunker whose maximum is below its minimum. Each of those turns into a warning
 * light nobody reads three weeks later, so they are boot errors instead. The rules mirror
 * {@code mock-api/src/config.ts} one-for-one: the two stacks must refuse the same
 * configurations or the mock stops being a rehearsal of the real one.
 */
@Component
public class ProviderPropertiesValidator implements ApplicationListener<ContextRefreshedEvent> {

  private static final Logger log = LoggerFactory.getLogger(ProviderPropertiesValidator.class);

  /** The width of {@code knowledge_chunks.embedding} in V1__init.sql. */
  private static final int VECTOR_COLUMN_DIMENSIONS = 1024;

  private final AppProperties properties;
  private final Environment environment;

  public ProviderPropertiesValidator(AppProperties properties, Environment environment) {
    this.properties = properties;
    this.environment = environment;
  }

  @Override
  public void onApplicationEvent(ContextRefreshedEvent event) {
    boolean production = isProduction();
    AppProperties.Rag rag = properties.rag();
    AppProperties.Mail mail = properties.mail();
    AppProperties.Ingestion ingestion = properties.ingestion();

    // 1. A provider that is named but not wired must fail here, not on the first
    //    question. Falling back to the mock instead would make a broken deployment look
    //    exactly like a working one, and the answers would be plausible either way.
    if (requiresCredentials(rag.llmProvider()) && !rag.llmConfigured()) {
      throw new IllegalStateException(
          "LLM_PROVIDER=" + rag.llmProvider() + " requires LLM_BASE_URL and LLM_API_KEY to be set. "
              + "Set them, or use LLM_PROVIDER=mock \u2014 a missing credential must not silently"
              + " downgrade a deployment to canned answers.");
    }
    if (requiresCredentials(rag.embeddingProvider()) && !rag.embeddingConfigured()) {
      throw new IllegalStateException(
          "EMBEDDING_PROVIDER=" + rag.embeddingProvider()
              + " requires EMBEDDING_BASE_URL and EMBEDDING_API_KEY, or the LLM_* pair.");
    }

    // 2. vector(1024) is a migration, not an environment variable: a mismatched width is
    //    a re-embed of the corpus, so it is a warning at boot and a rejection at insert.
    if (rag.embeddingDimensions() != VECTOR_COLUMN_DIMENSIONS) {
      log.warn(
          "EMBEDDING_DIMENSIONS={} does not match vector({}) in V1__init.sql; chunks will be"
              + " rejected at insert time until the column and the model agree",
          rag.embeddingDimensions(),
          VECTOR_COLUMN_DIMENSIONS);
    }

    // 3. Chunking parameters that contradict each other produce a corpus of one-token
    //    chunks, which retrieves like noise and looks fine in the job counters.
    if (ingestion.chunkMaxTokens() <= ingestion.chunkMinTokens()) {
      throw new IllegalStateException(
          "CHUNK_MAX_TOKENS must exceed CHUNK_MIN_TOKENS (got "
              + ingestion.chunkMaxTokens() + " and " + ingestion.chunkMinTokens() + ").");
    }
    if (ingestion.maxRedirects() < 0 || ingestion.maxRedirects() > 6) {
      throw new IllegalStateException("INGEST_MAX_REDIRECTS must be between 0 and 6.");
    }

    // 4. Password reset is the one flow that cannot be completed in-app, so production
    //    has to be able to send it. `log` and `none` remain legal outside production,
    //    where the API states plainly that no mail was delivered (R8).
    if (mail.isSmtp() && (!hasText(mail.host()) && !hasText(mail.url()))) {
      throw new IllegalStateException("MAIL_TRANSPORT=smtp requires SMTP_HOST or SMTP_URL.");
    }
    if (mail.isSmtp() && !hasText(mail.from())) {
      throw new IllegalStateException("MAIL_TRANSPORT=smtp requires SMTP_FROM.");
    }
    if (production) {
      if (!mail.isSmtp()) {
        throw new IllegalStateException(
            "MAIL_TRANSPORT must be smtp in production, or password reset cannot be delivered.");
      }
      // 5. The SSRF gate. Private-network fetches exist so the pipeline can be tested
      //    against a local fixture; on a public deployment it is a way to reach the
      //    metadata endpoint of whatever cloud the app runs in (docs/SECURITY.md §9).
      if (ingestion.allowPrivateNetworks()) {
        throw new IllegalStateException(
            "INGEST_ALLOW_PRIVATE_NETWORKS must be false in production (SSRF).");
      }
    }

    // 6. The cache's similarity floor. Below ~0.90 a "near-enough" match returns a
    //    different question's answer; above 1 it is dead code. Either is a silent
    //    correctness change to every answer served from cache.
    AppProperties.Answers.Cache cache = properties.answers().cache();
    if (cache.enabled() && (cache.similarity() <= 0.90 || cache.similarity() > 1.0)) {
      throw new IllegalStateException(
          "SEMANTIC_CACHE_SIMILARITY must be in (0.90, 1.0]; got " + cache.similarity() + ".");
    }
    if (cache.enabled() && cache.ttlSeconds() < 10) {
      throw new IllegalStateException("ANSWER_CACHE_TTL_SECONDS must be at least 10; a shorter TTL"
          + " makes the cache a source of flaky answers rather than an optimisation.");
    }

    log.info(
        "provider configuration accepted: llm={} embedding={} mockLlm={} mail={} ingestPrivate={}",
        rag.llmProvider(),
        rag.embeddingProvider(),
        rag.isMockLlm(),
        mail.transport(),
        ingestion.allowPrivateNetworks());
  }

  /** Any provider other than the offline mock has to be reachable to be worth naming. */
  private static boolean requiresCredentials(String provider) {
    return provider != null && !"mock".equalsIgnoreCase(provider);
  }

  private static boolean hasText(String value) {
    return value != null && !value.isBlank();
  }

  private boolean isProduction() {
    for (String profile : environment.getActiveProfiles()) {
      if (profile.equalsIgnoreCase("prod") || profile.equalsIgnoreCase("production")) return true;
    }
    return "production".equalsIgnoreCase(environment.getProperty("SPRING_PROFILES_ACTIVE", ""));
  }
}
