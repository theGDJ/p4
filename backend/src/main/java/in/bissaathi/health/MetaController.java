package in.bissaathi.health;

import in.bissaathi.common.AppProperties;
import in.bissaathi.common.EvidenceTier;
import in.bissaathi.common.VerificationStatus;
import in.bissaathi.repo.KnowledgeChunkRepository;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Liveness, readiness and the public bootstrap document.
 *
 * /health is the load-balancer probe and answers in microseconds with no database
 * contact: a probe that depends on Postgres turns a slow database into a fleet-wide
 * restart loop. /health/ready is the opposite — it fails when the database or Redis
 * is down, which is exactly when traffic should stop.
 *
 * /meta/bootstrap is what the frontend reads at startup. It publishes the real
 * knowledge-base counts and, prominently, whether the LLM provider is a mock. The
 * client must badge mock output, so this flag is part of the security model rather
 * than a diagnostic (R8/R10).
 */
@RestController
@RequestMapping("/api/v1")
public class MetaController {

  private static final Instant START = Instant.now();

  private final AppProperties properties;
  private final KnowledgeChunkRepository chunks;
  private final String version;
  private final String profile;

  public MetaController(
      AppProperties properties,
      KnowledgeChunkRepository chunks,
      @Value("${spring.application.name:bis-saathi}") String applicationName,
      @Value("${build.version:0.1.0}") String version,
      @Value("${spring.profiles.active:dev}") String profile) {
    this.properties = properties;
    this.chunks = chunks;
    this.version = version;
    this.profile = profile;
  }

  /**
   * Liveness. No dependency checks at all: a pod restart because Postgres is slow
   * turns one outage into a total one, and Boot's graceful-shutdown grace period is
   * shorter than a stuck connection pool.
   */
  @GetMapping(value = "/health/live", produces = MediaType.APPLICATION_JSON_VALUE)
  public ResponseEntity<Map<String, Object>> live() {
    return ResponseEntity.ok()
        .cacheControl(CacheControl.noStore())
        .body(Map.of("status", "UP", "uptimeSeconds", java.time.Duration.between(START, Instant.now()).getSeconds()));
  }

  /**
   * Readiness: the documented path is /health/ready, checked here rather than by
   * delegating to Actuator.
   *
   * Actuator serves /actuator-style paths of /health, /health/liveness and
   * /health/readiness. docs/API.md fixes /health/live and /health/ready, so the
   * endpoints are implemented against the contract instead of rewriting URLs to fit
   * the framework's default naming — the API document is the authority, and a proxy
   * rule that maps one name to another is exactly the indirection that lets a health
   * check quietly stop checking anything. The web exposure of Actuator health is
   * therefore switched off in application.yml.
   */
  @GetMapping(value = "/health/ready", produces = MediaType.APPLICATION_JSON_VALUE)
  public ResponseEntity<Map<String, Object>> ready() {
    long approvedChunks;
    try {
      approvedChunks = chunks.countByReviewStateAndVerificationStatusNot("APPROVED", VerificationStatus.SUPERSEDED);
    } catch (RuntimeException e) {
      // The database is unreachable. Report DOWN; do not serve a healthy-looking
      // response built from a default (R8).
      return ResponseEntity.status(503)
          .cacheControl(CacheControl.noStore())
          .body(Map.of(
              "status", "DOWN",
              "components",
              Map.of("database", Map.of("status", "DOWN", "detail", "unreachable"),
                  "knowledgeBase", Map.of("status", "UNKNOWN"))));
    }
    return ResponseEntity.ok()
        .cacheControl(CacheControl.noStore())
        .body(Map.of(
            "status", "UP",
            "components",
            Map.of("database", Map.of("status", "UP"),
                // Reported, not assumed: the knowledge base being empty is a valid
                // state (a fresh deployment) and readiness must not lie about it.
                "knowledgeBase", Map.of("status", "UP", "approvedChunks", approvedChunks))));
  }

  @GetMapping(value = "/meta/bootstrap", produces = MediaType.APPLICATION_JSON_VALUE)
  public Map<String, Object> bootstrap() {
    Map<String, Object> app = new LinkedHashMap<>();
    app.put("name", "BIS-Saathi");
    app.put("version", version);
    app.put("env", profile);
    app.put("stack", "react-vite / spring-boot / postgres-pgvector / redis");
    // The two flags the UI needs in order to tell the truth about itself.
    app.put("mockProvider", properties.rag().isMockLlm());
    app.put("providerName", properties.rag().isMockLlm() ? "mock" : properties.rag().llmProvider());

    Map<String, Object> auth = new LinkedHashMap<>();
    auth.put("accessTokenTtlMinutes", properties.jwt().accessTtlMinutes());
    auth.put("personas", properties.personas());
    auth.put("languages", properties.languages());
    auth.put("passwordMinLength", properties.password().minLength());
    auth.put("lockoutAfterFailedAttempts", properties.lockout().maxFailedAttempts());
    auth.put("lockoutMinutes", properties.lockout().lockMinutes());

    // Live counts, never a projection: an empty knowledge base is visible as 0, which
    // is why the landing page can warn the user before their first question.
    Map<String, Object> knowledge = new LinkedHashMap<>();
    knowledge.put("approvedDocuments", chunks.count());
    knowledge.put("approvedChunks", chunks.countByReviewStateAndVerificationStatusNot("APPROVED", VerificationStatus.SUPERSEDED));
    knowledge.put("kbVersion", 1);

    Map<String, Object> security = new LinkedHashMap<>();
    security.put("passwordScheme", properties.password().scheme());
    security.put("csrfEnabled", properties.csrf().enabled());

    Map<String, Object> result = new LinkedHashMap<>();
    result.put("app", app);
    result.put("auth", auth);
    result.put("knowledge", knowledge);
    result.put("security", security);
    // R5 ships from the server so a translation edit cannot desynchronise the
    // disclaimer from the answer it qualifies.
    result.put("disclaimer", properties.answers().disclaimerEn());
    result.put("evidenceTiers", java.util.Arrays.stream(EvidenceTier.values()).map(Enum::name).toList());
    return result;
  }
}
