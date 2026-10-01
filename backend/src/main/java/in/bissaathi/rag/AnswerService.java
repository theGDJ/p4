package in.bissaathi.rag;

import in.bissaathi.common.AppProperties;
import in.bissaathi.common.EvidenceTier;
import in.bissaathi.common.Intent;
import in.bissaathi.common.Language;
import java.util.ArrayList;
import java.util.List;
import org.springframework.stereotype.Service;

/**
 * Decides what an answer is allowed to look like (§5, R4/R5/R7/R8/R10).
 *
 * The ordering below is the safety property. Each branch is a hard stop, and the
 * order encodes which stop takes precedence:
 *
 *   1. out_of_scope / chitchat / meta — no retrieval, no model call. A refusal that
 *      retrieves first has already leaked the question into an embedding pipeline.
 *   2. clarify — up to three focused questions, no retrieval. Guessing an
 *      interpretation and answering it is how a system produces a confident answer to
 *      a question nobody asked.
 *   3. retrieval empty — the exact R4 sentence, tier NONE, and NO model call. This
 *      is the branch that makes fabricated sourcing structurally impossible: there
 *      is no generation step left to fabricate in.
 *   4. retrieval non-empty + mock provider — an explicit PROVIDER_UNAVAILABLE
 *      failure (R8). A mock that wrote fluent prose would pass every test and lie to
 *      every user.
 *   5. retrieval non-empty + real provider — generate at temperature 0, then
 *      validate citations (R3), then compute the tier from what survived.
 *
 * Branch 3 is the one that runs in a P1 deployment with an empty knowledge base, and
 * it is correct behaviour, not a stub.
 */
@Service
public class AnswerService {

  private final AppProperties properties;

  public AnswerService(AppProperties properties) {
    this.properties = properties;
  }

  /**
   * @param language the language the answer must be written in. The R4 sentence and
   *     the R5 label are stored per language as literal configuration, and this class
   *     copies them verbatim — a paraphrase of a contractual sentence is a wrong
   *     sentence.
   */
  public Decision decide(String question, Intent intent, List<RetrievedChunk> retrieved, Language language) {
    Language languageOrDefault = language == null ? Language.en : language;

    if (intent == Intent.out_of_scope) {
      return new Decision(
          intent,
          refusal(languageOrDefault),
          List.of(),
          EvidenceTier.NONE,
          List.of(),
          /* generates */ false,
          /* retrievalWanted */ false);
    }

    if (intent == Intent.chitchat || intent == Intent.meta) {
      return new Decision(
          intent, greeting(languageOrDefault), List.of(), EvidenceTier.NONE, List.of(), false, false);
    }

    if (intent == Intent.clarify) {
      return new Decision(
          intent, clarifyingQuestions(languageOrDefault), List.of(), EvidenceTier.NONE, List.of(), false, false);
    }

    if (retrieved.isEmpty()) {
      // R4. Exact sentence, tier NONE, plus a pointer to the official channel.
      return new Decision(
          intent,
          insufficientEvidence(languageOrDefault),
          List.of(),
          EvidenceTier.NONE,
          followUpsFor(intent, languageOrDefault),
          false,
          true);
    }

    return new Decision(
        intent, null, retrieved, EvidenceTier.NONE, followUpsFor(intent, languageOrDefault), true, true);
  }

  /**
   * Evidence tier, computed by rule (§5). Never from a model's self-assessment.
   *
   * STRONG requires two or more approved chunks at or above the score threshold AND
   * every citation the model used to resolve. One usable source, or any dropped
   * citation, is PARTIAL. Nothing usable is NONE.
   */
  public EvidenceTier computeEvidenceTier(List<RetrievedChunk> validatedSources, boolean allCitationsValid) {
    if (validatedSources.isEmpty()) {
      return EvidenceTier.NONE;
    }
    double threshold = properties.rag().evidenceScoreThreshold();
    List<RetrievedChunk> above = new ArrayList<>();
    for (RetrievedChunk chunk : validatedSources) {
      if (chunk.score() >= threshold) above.add(chunk);
    }
    if (above.isEmpty()) return EvidenceTier.NONE;
    if (above.size() >= 2 && allCitationsValid) return EvidenceTier.STRONG;
    return EvidenceTier.PARTIAL;
  }

  /* ------------------------------------------------------------------- sentences */

  /** R4, verbatim. Tests assert this string exactly. */
  public String insufficientEvidence(Language language) {
    return properties.answers().insufficientEvidence(language);
  }

  /** R5, verbatim. Rendered on every answer, report and guide. */
  public String disclaimer(Language language) {
    return properties.answers().disclaimer(language);
  }

  private String refusal(Language language) {
    return language == Language.hi
        ? "यह BIS मानकों और सेवाओं के बाहर का विषय है। मैं इसमें सहायता नहीं कर सकता।"
        : "This is outside the scope of Indian Standards and BIS services, so I cannot answer it.";
  }

  private String greeting(Language language) {
    return language == Language.hi
        ? "मैं BIS मानकों, प्रमाणन और हॉलमार्किंग से संबंधित प्रश्नों में सहायता करता हूँ।"
        : "I answer questions about Indian Standards, BIS certification and hallmarking.";
  }

  private String clarifyingQuestions(Language language) {
    return language == Language.hi
        ? "ताकि मैं सही मानक खोज सकूँ, कृपया बताएँ: (1) उत्पाद या सेवा क्या है?"
            + " (2) यह किस उद्देश्य के लिए है — आयात, निर्यात, या घरेलू बिक्री?"
            + " (3) क्या आपको कोई मानक संख्या, जैसे IS 12345, ज्ञात है?"
        : "So that I can find the right standard, please tell me: (1) what is the product or service?"
            + " (2) Is it for import, export, or domestic sale?"
            + " (3) Do you have a standard number or part, e.g. IS 12345?";
  }

  /** Follow-up questions, capped at maxFollowUps, in the same language (§12). */
  public List<String> followUpsFor(Intent intent, Language language) {
    int max = properties.rag().maxFollowUps();
    if (max <= 0) return List.of();
    List<String> candidates =
        language == Language.hi ? Hindi.followUps(intent) : English.followUps(intent);
    return candidates.subList(0, Math.min(max, candidates.size()));
  }

  /** The decision the chat module streams from. */
  public record Decision(
      Intent intent,
      String fixedAnswer,
      List<RetrievedChunk> retrieved,
      EvidenceTier tier,
      List<String> followUps,
      boolean generates,
      boolean retrievalWanted) {

    public boolean hasFixedAnswer() {
      return fixedAnswer != null;
    }
  }

  private static final class English {
    static List<String> followUps(Intent intent) {
      return switch (intent) {
        case certification -> List.of(
            "Which product category are you certifying?",
            "Do you already have a factory inspection report?",
            "Is this for domestic sale or for export?");
        case hallmark -> List.of(
            "Which metal and which carat are you hallmarking?",
            "Are you a jeweller or a retailer?",
            "Do you need a HUID or a BIS mark?");
        case lab -> List.of(
            "Which state are you in?",
            "Which test parameter do you need measured?",
            "Do you need a BIS-recognised lab or a NABL-accredited one?");
        case recommend, factual, compare -> List.of(
            "Which product or material is this for?",
            "Is the standard for manufacture, testing, or labelling?",
            "Do you need the current revision or a specific published year?");
        default -> List.of(
            "Which Indian Standard number are you asking about?",
            "Is this about certification, hallmarking, or lab testing?");
      };
    }
  }

  private static final class Hindi {
    static List<String> followUps(Intent intent) {
      return switch (intent) {
        case certification -> List.of(
            "आप किस उत्पाद श्रेणी के लिए प्रमाणन चाहते हैं?",
            "क्या आपके पास पहले से कारखाना निरीक्षण रिपोर्ट है?",
            "यह घरेलू बिक्री के लिए है या निर्यात के लिए?");
        case hallmark -> List.of(
            "आप किस धातु और किस कैरेट की हॉलमार्किंग कराना चाहते हैं?",
            "क्या आप आभूषकार हैं या थोक/खुदरा विक्रेता?",
            "क्या आपको HUID चाहिए या BIS मार्क?");
        case lab -> List.of(
            "आप किस राज्य में हैं?",
            "किस पैरामीटर (मापदंड) की जांच करानी है?",
            "क्या आपको BIS-स्वीकृत प्रयोगशाला चाहिए या NABL-मान्यता प्राप्त?");
        case recommend, factual, compare -> List.of(
            "यह किस उत्पाद या सामग्री के लिए है?",
            "क्या यह मानक विनिर्माण, परीक्षण या लेबलिंग के लिए है?",
            "आपको वर्तमान संस्करण चाहिए या कोई विशिष्ट प्रकाशन वर्ष?");
        default -> List.of(
            "आप किस भारतीय मानक संख्या के बारे में पूछ रहे हैं?",
            "क्या यह प्रमाणन, हॉलमार्किंग या प्रयोगशाला परीक्षण से संबंधित है?");
      };
    }
  }
}
