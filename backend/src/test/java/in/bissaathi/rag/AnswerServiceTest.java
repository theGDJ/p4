package in.bissaathi.rag;

import static org.assertj.core.api.Assertions.assertThat;

import in.bissaathi.common.AppProperties;
import in.bissaathi.common.EvidenceTier;
import in.bissaathi.common.Intent;
import in.bissaathi.common.Language;
import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * The pipeline's branch selection, the exactness of the two contractual sentences,
 * and the rule-based evidence tier.
 */
class AnswerServiceTest {

  private static final String R4_EN =
      "I could not find sufficient information in the authorized knowledge base to answer this reliably.";
  private static final String R4_HI =
      "मुझे इसका विश्वसनीय उत्तर देने के लिए अधिकृत ज्ञान-कोष में पर्याप्त जानकारी नहीं मिली।";

  private final AppProperties properties = TestProperties.defaults();
  private final AnswerService service = new AnswerService(properties);

  @Test
  @DisplayName("empty retrieval returns the exact R4 sentence and tier NONE, with no generation")
  void emptyRetrievalIsR4() {
    AnswerService.Decision decision = service.decide("Does IS 123 cover pumps?", Intent.factual, List.of(), Language.en);

    assertThat(decision.fixedAnswer()).isEqualTo(R4_EN);
    assertThat(decision.tier()).isEqualTo(EvidenceTier.NONE);
    assertThat(decision.generates()).isFalse();
    assertThat(decision.retrieved()).isEmpty();
  }

  @Test
  @DisplayName("the Hindi R4 sentence is the same string as the frontend's, character for character")
  void emptyRetrievalIsR4InHindi() {
    AnswerService.Decision decision = service.decide("क्या IS 123 पंप पर लागू होता है?", Intent.factual, List.of(), Language.hi);

    assertThat(decision.fixedAnswer()).isEqualTo(R4_HI);
  }

  @Test
  @DisplayName("out-of-scope never retrieves and never generates")
  void refusalShortCircuits() {
    AnswerService.Decision decision = service.decide("which stock to buy", Intent.out_of_scope, List.of(), Language.en);

    assertThat(decision.retrievalWanted()).isFalse();
    assertThat(decision.generates()).isFalse();
    assertThat(decision.followUps()).isEmpty();
  }

  @Test
  @DisplayName("clarify asks questions instead of guessing an interpretation")
  void clarifyAsks() {
    AnswerService.Decision decision = service.decide("standard", Intent.clarify, List.of(), Language.en);

    assertThat(decision.retrievalWanted()).isFalse();
    assertThat(decision.fixedAnswer()).contains("(1)").contains("(2)").contains("(3)");
  }

  @Test
  @DisplayName("retrieval with a mock provider is an error, not a fluent guess")
  void mockProviderFailsLoudly() {
    LlmProvider provider = new MockLlmProvider();
    assertThat(provider.isMock()).isTrue();
    org.assertj.core.api.Assertions.assertThatThrownBy(
            () ->
                provider.generate(
                    new LlmProvider.Request("q", "en", "factual", "sys", List.of()), java.util.Map.of()))
        .isInstanceOf(MockLlmProvider.ProviderUnavailableException.class)
        .hasMessageContaining("deterministic mock");
  }

  @Test
  @DisplayName("STRONG needs two chunks above threshold and every citation valid")
  void strongTier() {
    List<RetrievedChunk> two = List.of(chunk(0.5), chunk(0.4));
    assertThat(service.computeEvidenceTier(two, true)).isEqualTo(EvidenceTier.STRONG);
    // One dropped citation is enough to lose STRONG.
    assertThat(service.computeEvidenceTier(two, false)).isEqualTo(EvidenceTier.PARTIAL);
    // Below threshold, even two chunks is not STRONG.
    assertThat(service.computeEvidenceTier(List.of(chunk(0.01), chunk(0.01)), true)).isEqualTo(EvidenceTier.NONE);
  }

  @Test
  @DisplayName("tier is NONE when nothing survived validation, whatever the model claimed")
  void emptySourcesAreNone() {
    assertThat(service.computeEvidenceTier(List.of(), true)).isEqualTo(EvidenceTier.NONE);
    assertThat(service.computeEvidenceTier(List.of(), false)).isEqualTo(EvidenceTier.NONE);
  }

  @Test
  @DisplayName("follow-ups are in the answer language and capped")
  void followUpsAreLocalizedAndCapped() {
    assertThat(service.followUpsFor(Intent.factual, Language.hi)).allSatisfy(text -> assertThat(text).matches(".*[\\u0900-\\u097F].*"));
    assertThat(service.followUpsFor(Intent.factual, Language.en)).hasSizeLessThanOrEqualTo(properties.rag().maxFollowUps());
    assertThat(service.followUpsFor(Intent.factual, Language.hi)).isNotEqualTo(service.followUpsFor(Intent.factual, Language.en));
  }

  @Test
  @DisplayName("the thresholds the tests assume are the ones application.yml ships")
  void matchesTheYamlDefaults() throws java.io.IOException {
    // Read the shipped YAML instead of trusting a comment: if someone tunes
    // evidence-score-threshold there, this fails and the unit tests are updated
    // deliberately rather than silently diverging from production behaviour.
    java.nio.file.Path yaml = java.nio.file.Path.of("src/main/resources/application.yml");
    if (!java.nio.file.Files.exists(yaml)) return; // surefire runs from the module root
    String text = java.nio.file.Files.readString(yaml, java.nio.charset.StandardCharsets.UTF_8);

    assertThat(text).contains("evidence-score-threshold: 0.12");
    assertThat(text).contains("max-context-chunks: 6");
    assertThat(text).contains("access-ttl-minutes: ${JWT_ACCESS_TTL_MINUTES:15}");
    assertThat(text).contains("min-length: 10");
    assertThat(text).contains("max-failed-attempts: ${LOGIN_MAX_FAILED_ATTEMPTS:5}");
  }

  @Test
  @DisplayName("the R5 disclaimer is published with every generated answer")
  void disclaimerIsPresent() {
    assertThat(service.disclaimer(Language.en)).isEqualTo("Informational — verify against current official sources");
    assertThat(service.disclaimer(Language.hi)).isEqualTo("सूचनात्मक — कृपया वर्तमान आधिकारिक स्रोतों से सत्यापित करें");
  }

  private static RetrievedChunk chunk(double score) {
    return new RetrievedChunk(
        "c1", "v1", "title", "IS 1", "1.1", "IS", Language.en, "https://example.org", 
        in.bissaathi.common.VerificationStatus.VERIFIED, java.time.Instant.now(), "text", score);
  }
}
