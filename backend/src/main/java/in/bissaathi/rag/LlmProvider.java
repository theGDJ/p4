package in.bissaathi.rag;

import java.util.List;
import java.util.Map;

/**
 * The single seam between this application and any language model (§3).
 *
 * Providers are config-switchable and, critically, mockable: retrieval, citation
 * validation and the evidence tiers must be testable offline. Every implementation is
 * required to report {@link #isMock()} truthfully, because the UI badges mock output
 * and an implementation that lied here would make that badge a decoration (R8/R10).
 */
public interface LlmProvider {

  /** A grounded generation request. Nothing outside `context` may be cited. */
  record Request(String question, String language, String intent, String systemPrompt, List<Chunk> context) {}

  /** One retrieved passage handed to the model as the only admissible evidence. */
  record Chunk(String chunkId, String title, String standardNo, String section, String text, double score) {}

  /**
   * The model's raw output. `citations` are the references the model claimed to use;
   * they are untrusted input until CitationValidator has checked each one against the
   * retrieved set (R3).
   */
  record Completion(String text, List<String> citations, int promptTokens, int completionTokens, String model) {}

  Completion generate(Request request, Map<String, Object> options);

  /** Name published to the client in the usage frame and the MOCK PROVIDER badge. */
  String name();

  boolean isMock();
}
