package in.bissaathi.rag;

import static org.assertj.core.api.Assertions.assertThat;

import in.bissaathi.common.Intent;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Intent routing, including the two failure modes that are specific to a bilingual
 * product. Both were found by testing this class.
 *
 *  1. A refusal must win over a domain word. "which stock should I buy before the IS
 *     12345 revision" contains a standard number and is still out of scope.
 *  2. Hindi rules must actually match. \b and ASCII-oriented word boundaries never
 *     match a Devanagari token, so a Hindi keyword rule written that way is silently
 *     dead: every English test passes and Hindi users get "factual" for everything.
 */
class IntentRouterTest {

  private final IntentRouter router = new IntentRouter();

  @Test
  @DisplayName("out-of-scope beats every other signal")
  void outOfScopeWins() {
    assertThat(router.route("Which stock should I buy before the IS 12345 revision?")).isEqualTo(Intent.out_of_scope);
    assertThat(router.route("what is the cricket score today")).isEqualTo(Intent.out_of_scope);
    assertThat(router.route("मुझे शेयर बाजार के बारे में बताओ")).isEqualTo(Intent.out_of_scope);
  }

  @Test
  @DisplayName("Hindi markers match without relying on word boundaries")
  void hindiMarkersMatch() {
    assertThat(router.route("हॉलमार्क के लिए क्या करना है")).isEqualTo(Intent.hallmark);
    assertThat(router.route("उत्पाद के लिए प्रमाणन कैसे मिलेगा")).isEqualTo(Intent.certification);
    assertThat(router.route("किस राज्य में प्रयोगशाला है")).isEqualTo(Intent.lab);
  }

  @Test
  @DisplayName("greetings and capability questions never reach retrieval")
  void nonInformationalIntents() {
    assertThat(router.route("hello")).isEqualTo(Intent.chitchat);
    assertThat(router.route("नमस्ते")).isEqualTo(Intent.chitchat);
    assertThat(router.route("what can you do")).isEqualTo(Intent.meta);
  }

  @Test
  @DisplayName("a bare domain word is a question that needs clarifying")
  void vagueQuestionsClarify() {
    assertThat(router.route("standard")).isEqualTo(Intent.clarify);
    assertThat(router.route("IS standard")).isEqualTo(Intent.clarify);
  }

  @Test
  @DisplayName("domain vocabulary alone is not specificity, but a product signal is")
  void productSignalRemovesVagueness() {
    assertThat(router.route("which standard applies to my factory")).isNotEqualTo(Intent.clarify);
    assertThat(router.route("which Indian Standard applies to drinking water in India")).isEqualTo(Intent.factual);
  }

  @Test
  @DisplayName("a comparison is a comparison even when it is also on-topic")
  void compareWins() {
    assertThat(router.route("difference between IS 12345 and IS 67890")).isEqualTo(Intent.compare);
  }
}
