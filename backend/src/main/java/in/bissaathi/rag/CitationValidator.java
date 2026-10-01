package in.bissaathi.rag;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * R3: every citation in a generated answer must resolve to a retrieved chunk, and
 * every claim must map to its source.
 *
 * The validator is the guard against the single most likely failure mode of a RAG
 * system: a model that produces a correct-sounding answer with a plausible-looking
 * "IS 12345:2020, Clause 4.2" that was never in the context window. Three rules:
 *
 *  1. A reference may only name a chunk that was actually retrieved for this
 *     question. Unknown references are dropped, not kept-and-flagged: a citation the
 *     server cannot vouch for is not a citation.
 *  2. Titles, standard numbers, sections and URLs come from the database row, never
 *     from the model's text. The model is allowed to say [S1]; it is not allowed to
 *     describe it.
 *  3. Dropping a citation is reported to the caller so the evidence tier can be
 *     downgraded. An answer whose citations did not survive is PARTIAL or NONE, and
 *     the user sees that, rather than a clean-looking answer with quietly missing
 *     support.
 */
@Component
public class CitationValidator {

  private static final Logger log = LoggerFactory.getLogger(CitationValidator.class);

  /** A citation the model may emit: [S1], [S12], [1]. */
  private static final Pattern CITED = Pattern.compile("\\[\\s*S?(\\d{1,2})\\s*]");

  /**
   * @param claimedRefs the references the model used, in order of appearance
   * @param availableIds the ids of the chunks actually retrieved, in S1..Sn order
   * @return the validated citation set and the refs that were rejected
   */
  public Result validate(String answerText, List<String> claimedRefs, List<RetrievedChunk> available) {
    List<String> cited = extractRefs(answerText, claimedRefs);

    // The index space is 1-based: S1 is available.get(0).
    Set<Integer> kept = new LinkedHashSet<>();
    List<String> dropped = new ArrayList<>();
    for (String ref : cited) {
      int index = indexOf(ref);
      if (index >= 0 && index < available.size()) {
        kept.add(index);
      } else {
        dropped.add(ref);
      }
    }

    if (!dropped.isEmpty()) {
      log.warn("citation validation dropped {} unverifiable reference(s): {}", dropped.size(), dropped);
    }

    List<RetrievedChunk> sources = new ArrayList<>(kept.size());
    for (Integer index : kept) {
      sources.add(available.get(index));
    }
    return new Result(sources, List.copyOf(dropped), dropped.isEmpty() && !sources.isEmpty());
  }

  /** Union of the bracketed refs found in the prose and the refs the model declared. */
  private static List<String> extractRefs(String answerText, List<String> claimedRefs) {
    // A fresh Matcher per call, and no shared Matcher instance on a field: Matcher is
    // not thread-safe and a shared one leaks state between requests.
    List<String> refs = new ArrayList<>();
    if (answerText != null) {
      Matcher matcher = CITED.matcher(answerText);
      while (matcher.find()) {
        refs.add("S" + matcher.group(1));
      }
    }
    if (claimedRefs != null) {
      for (String ref : claimedRefs) {
        if (ref == null) continue;
        String normalized = normaliseRef(ref);
        // Compare in normalised form: a prose "[S1]" and a declared "1" are the same
        // citation, and treating them as distinct would double-count one source.
        if (!refs.contains(normalized)) refs.add(normalized);
      }
    }
    return refs;
  }

  private static String normaliseRef(String ref) {
    String value = ref.trim().toUpperCase();
    return value.startsWith("S") ? value : "S" + value;
  }

  private static int indexOf(String ref) {
    try {
      return Integer.parseInt(ref.substring(1)) - 1;
    } catch (RuntimeException e) {
      return -1;
    }
  }

  /** Validated evidence for one answer. */
  public record Result(List<RetrievedChunk> sources, List<String> droppedRefs, boolean allCitationsValid) {}
}
