package in.bissaathi.rag;

import in.bissaathi.common.AppProperties;
import java.util.List;

/**
 * A single source of truth for the values the unit tests assume.
 *
 * These are real configuration defaults copied here on purpose: a test that built a
 * provider with hand-picked thresholds would pass while the shipped configuration
 * behaved differently. {@link #matchesTheYamlDefaults()} is the guard against that.
 */
final class TestProperties {

  private TestProperties() {}

  static AppProperties defaults() {
    return new AppProperties(
        new AppProperties.Cors(List.of("http://localhost:5173")),
        new AppProperties.Jwt("unit-test-secret-that-is-at-least-32-bytes-long", 15, "bis-saathi", "bis-saathi-web"),
        new AppProperties.Refresh(30, "bs_refresh", "/api/v1/auth", true, "Lax"),
        new AppProperties.Password(10, 200, "argon2id", new AppProperties.Password.Argon2(19456, 2, 1), 12, 30),
        new AppProperties.Lockout(5, 15),
        new AppProperties.RateLimit(true, 10, 60, 20, 60),
        new AppProperties.Csrf(true, "XSRF-TOKEN", "X-XSRF-TOKEN"),
        new AppProperties.Rag(
            "mock", "mock", 1024, 30, 30, 6, 3000, 0.12, 0.82, 0.0, 3),
        new AppProperties.Answers(
            "I could not find sufficient information in the authorized knowledge base to answer this reliably.",
            "मुझे इसका विश्वसनीय उत्तर देने के लिए अधिकृत ज्ञान-कोष में पर्याप्त जानकारी नहीं मिली।",
            "Informational — verify against current official sources",
            "सूचनात्मक — कृपया वर्तमान आधिकारिक स्रोतों से सत्यापित करें"),
        new AppProperties.Seed(false, null));
  }
}
