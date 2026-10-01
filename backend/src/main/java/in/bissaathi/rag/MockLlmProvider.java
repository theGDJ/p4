package in.bissaathi.rag;

import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/**
 * The default provider.
 *
 * It refuses to generate whenever a real answer would be expected. That is not
 * laziness: the only honest behaviour for a stand-in is to say it cannot do the thing.
 * Returning fluent, plausible prose from a mock would make every downstream test that
 * checks answer quality meaningless, and a reviewer could not tell a working pipeline
 * from a decorative one (R10).
 *
 * It is reached only when retrieval found something — the empty-knowledge-base path is
 * decided before any model is consulted, in AnswerService.
 */
@Component
public class MockLlmProvider implements LlmProvider {

  @Override
  public Completion generate(Request request, Map<String, Object> options) {
    throw new ProviderUnavailableException(
        "The configured language model provider is the deterministic mock, which does not generate "
            + "answers. Set BISSAATHI_RAG_LLM_PROVIDER (or LLM_PROVIDER) to a real provider to enable "
            + "generation. Retrieved sources are still valid and are returned without a summary.");
  }

  @Override
  public String name() {
    return "mock";
  }

  @Override
  public boolean isMock() {
    return true;
  }

  /** Thrown by any provider that cannot serve the request; surfaced as PROVIDER_UNAVAILABLE. */
  public static class ProviderUnavailableException extends RuntimeException {
    public ProviderUnavailableException(String message) {
      super(message);
    }
  }
}
