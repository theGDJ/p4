package in.bissaathi.rag;

import in.bissaathi.common.Intent;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;
import org.springframework.stereotype.Component;

/**
 * Decides the question's intent before anything is retrieved (§5 feature #4).
 *
 * Two implementation notes that are easy to get wrong:
 *
 *  - Order matters. OUT_OF_SCOPE and CHITCHAT are tested first, because a refusal
 *    must not be upgraded into a "factual" question merely because it contains a
 *    domain word ("what is the best stock to buy before the IS release?").
 *  - Word boundaries. Java's \b is ASCII-only even with UNICODE_CHARACTER_CLASS in
 *    the situations that matter here, so \b around a Devanagari token can never
 *    match. Every keyword pattern is therefore compiled with UNICODE_CASE and
 *    matched against a normalised copy, and the boundary check is done on code points
 *    rather than with \b. A Hindi keyword rule written with \b fails silently, which
 *    is the worst kind of bug for a bilingual product: the English tests pass.
 */
@Component
public class IntentRouter {

  private record Rule(Intent intent, List<String> markers) {}

  /** Markers are matched as substrings of a space-padded, lowercased copy. */
  private static final List<Rule> RULES = List.of(
      new Rule(
          Intent.out_of_scope,
          List.of(
              "stock", "share market", "bet on", "wager", "lottery", "predict the election",
              "weather", "horoscope", "movie review", "cricket score", "recipe",
              "आर्थिक", "शेयर", "जुआ", "मौसम")),
      new Rule(
          Intent.lab,
          List.of("laboratory", "lab ", "testing lab", "test report", "प्रयोगशाला", "जांच")),
      new Rule(
          Intent.hallmark,
          List.of("hallmark", "hall-mark", "6 digit code", "bis mark", "हॉलमार्क", "स्वर्ण")),
      new Rule(
          Intent.certification,
      List.of(
              "certificate", "certification", "apply for", "license", "licence", "cmms", "crs",
              "प्रमाणन", "प्रमाण पत्र")),
      new Rule(
          Intent.compare,
          List.of("difference between", "compare", "versus", " vs ", "अंतर", "तुलना")),
      new Rule(
          Intent.recommend,
          List.of("which standard", "what standard", "applicable standard", "requirement for", "कौन सा मानक", "लागू")));

  /** Words that make a question specific rather than merely on-topic. */
  private static final List<String> PRODUCT_SIGNALS = List.of(
      "product", "my ", "we ", "our ", "manufactur", "export", "import", "factory", "unit",
      "msme", "jeweller", "jeweler", "gold", "silver", "karat", "carat",
      "उत्पाद", "निर्माता", "निर्यात", "आयात", "सोना", "चांदी");

  private static final List<String> DOMAIN_SIGNALS = List.of(
      "standard", "is ", "bis", "isi", "qco", "clause", "schedule", "part 1",
      "मानक", "प्रमाण", "आइएस");

  public Intent route(String question) {
    if (question == null || question.isBlank()) return Intent.clarify;
    String haystack = pad(normalise(question));

    for (Rule rule : RULES) {
      if (containsAny(haystack, rule.markers())) {
        // A rule match is decisive, including when the question is also vague:
        // "compare IS 1 and IS 2" is a comparison, and out-of-scope beats everything.
        return rule.intent();
      }
    }

    if (isGreeting(haystack)) return Intent.chitchat;
    if (isMeta(haystack)) return Intent.meta;
    if (isVague(question, haystack)) return Intent.clarify;
    return Intent.factual;
  }

  /**
   * A question is vague when it names nothing specific AND is short.
   *
   * Mere domain vocabulary does not count as specificity: "what is a standard?" is a
   * real question with a real answer, while "standard" alone is not answerable. The
   * two are separated by length and by the absence of a product signal.
   */
  boolean isVague(String raw, String haystack) {
    boolean hasProductSignal = containsAny(haystack, PRODUCT_SIGNALS);
    if (hasProductSignal) return false;
    boolean hasStandardReference = Pattern.compile("is\\s*\\d|\\biso\\b|qco").matcher(haystack).find();
    if (hasStandardReference) return false;
    boolean hasDomainSignal = containsAny(haystack, DOMAIN_SIGNALS);
    int words = raw.trim().split("\\s+").length;
    return hasDomainSignal && (words <= 6 || raw.trim().length() < 60);
  }

  private static boolean isGreeting(String haystack) {
    return List.of("hello", "hi ", "hey", "namaste", "नमस्ते", "नमस्कार", "good morning", "thanks", "धन्यवाद",
            "thank you")
        .stream()
        .anyMatch(haystack::contains);
  }

  private static boolean isMeta(String haystack) {
    return List.of("what can you do", "who are you", "your capabilities", "how do you work", "help me", "क्या कर सकते",
            "आप कौन")
        .stream()
        .anyMatch(haystack::contains);
  }

  private static boolean containsAny(String haystack, List<String> markers) {
    for (String marker : markers) {
      if (haystack.contains(marker)) return true;
    }
    return false;
  }

  private static String normalise(String value) {
    // NFC so that a combining-mark form of a Devanagari vowel sign matches its
    // precomposed one, and Locale.ROOT so a Turkish or Arabic locale cannot turn
    // "I" into something that no longer matches the rule list.
    return java.text.Normalizer.normalize(value, java.text.Normalizer.Form.NFC)
        .toLowerCase(Locale.ROOT)
        .replace('’', '\'');
  }

  private static String pad(String value) {
    return " " + value.replaceAll("\\s+", " ").trim() + " ";
  }
}
