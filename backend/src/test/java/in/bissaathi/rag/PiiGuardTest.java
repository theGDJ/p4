package in.bissaathi.rag;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * The PII guard. The negative cases matter more than the positive ones: an
 * over-eager mask corrupts the questions the product exists to answer, and nobody
 * notices that one — they only notice that the answer looks wrong.
 */
class PiiGuardTest {

  @Test
  @DisplayName("a 12-digit Aadhaar keeps only its last four")
  void aadhaarIsMasked() {
    PiiGuard.Result result = PiiGuard.scan("my aadhaar is 2345 6789 0123 please check");

    assertThat(result.detected()).isTrue();
    assertThat(result.kinds()).contains("aadhaar");
    assertThat(result.redacted()).contains("XXXX-XXXX-0123").doesNotContain("2345").doesNotContain("6789");
  }

  @Test
  @DisplayName("dashed and undashed forms are equivalent")
  void aadhaarFormats() {
    for (String form : new String[] {"234567890123", "2345-6789-0123", "2345 6789 0123"}) {
      assertThat(PiiGuard.scan("aadhaar " + form).redacted()).as(form).contains("XXXX-XXXX-0123");
    }
  }

  @Test
  @DisplayName("a standard number is never mistaken for an identifier")
  void standardNumbersSurvive() {
    String question = "Which Indian Standard, IS 12345:2020 or IS 98765, applies to drinking water?";
    PiiGuard.Result result = PiiGuard.scan(question);

    // This is the whole point of the length guards: a 5-digit or 8-digit run must pass
    // through untouched, or the product eats its own vocabulary.
    assertThat(result.redacted()).isEqualTo(question);
    assertThat(result.detected()).isFalse();
  }

  @Test
  @DisplayName("a clause reference like 4.2.1 is untouched")
  void clauseReferencesSurvive() {
    String question = "What does clause 4.2.1 of IS 456 say about cover?";
    assertThat(PiiGuard.scan(question).redacted()).isEqualTo(question);
  }

  @Test
  @DisplayName("PAN is masked with its last character retained")
  void panIsMasked() {
    PiiGuard.Result result = PiiGuard.scan("my PAN is ABCDE1234F for the licence fee");

    assertThat(result.kinds()).contains("pan");
    assertThat(result.redacted()).contains("AB*****F").doesNotContain("1234");
  }

  @Test
  @DisplayName("an Indian mobile keeps three digits")
  void phoneIsMasked() {
    for (String form : new String[] {"9876543210", "+91 98765 43210", "098765-43210"}) {
      PiiGuard.Result result = PiiGuard.scan("call me on " + form);
      assertThat(result.kinds()).as(form).contains("phone");
      assertThat(result.redacted()).as(form).contains("XXXXX210").doesNotContain("98765");
      // The caller's own prefix survives, so the masked line still reads naturally.
      if (form.startsWith("+91")) assertThat(result.redacted()).contains("+91 XXXXX210");
      if (form.startsWith("0")) assertThat(result.redacted()).startsWith("call 0XXXXX210");
    }
  }

  @Test
  @DisplayName("a long digit run that happens to start with 6-9 is left alone")
  void longerNumbersSurvive() {
    // Each of these contains a valid-looking 10-digit prefix. Masking them would
    // corrupt an order id, a GSTIN or a document reference — the failure mode that
    // shows up as a subtly wrong answer rather than as an error.
    for (String benign : new String[] {
      "order 6789012345678",
      "IS 4567812345678:2020",
      "invoice 98765432",
      "serial 1234567890",
    }) {
      assertThat(PiiGuard.scan(benign).redacted()).as(benign).isEqualTo(benign);
      assertThat(PiiGuard.scan(benign).detected()).as(benign).isFalse();
    }
  }

  @Test
  @DisplayName("an email keeps its local first character and its domain")
  void emailIsMasked() {
    PiiGuard.Result result = PiiGuard.scan("send it to asha.rao@example.org please");

    assertThat(result.kinds()).contains("email");
    assertThat(result.redacted()).contains("a***@example.org").doesNotContain("sha.rao");
  }

  @Test
  @DisplayName("a pasted bearer token is removed outright, with no tail")
  void jwtHasNoResidual() {
    String jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    PiiGuard.Result result = PiiGuard.scan("here is my token " + jwt);

    assertThat(result.kinds()).contains("token");
    assertThat(result.redacted()).contains("[REDACTED]").doesNotContain(jwt);
  }

  @Test
  @DisplayName("Hindi text with an identifier is masked without losing the words")
  void hindiQuestionKeepsItsMeaning() {
    PiiGuard.Result result = PiiGuard.scan("मेरा आधार 2345 6789 0123 है, मानक बताइए");

    assertThat(result.redacted()).contains("XXXX-XXXX-0123");
    assertThat(result.redacted()).contains("मेरा").contains("आधार").contains("मानक");
  }

  @Test
  @DisplayName("an empty or null question is safe to scan")
  void degenerateInputs() {
    assertThat(PiiGuard.scan(null).redacted()).isEmpty();
    assertThat(PiiGuard.scan(null).detected()).isFalse();
    assertThat(PiiGuard.scan("").detected()).isFalse();
    assertThat(PiiGuard.scan("   ").detected()).isFalse();
  }

  @Test
  @DisplayName("forLog truncates as well as masks")
  void logFormIsBounded() {
    String longQuestion = "aadhaar 2345 6789 0123 " + "x".repeat(500);
    String forLog = PiiGuard.forLog(longQuestion, 80);

    assertThat(forLog).hasSizeLessThanOrEqualTo(81);
    assertThat(forLog).doesNotContain("6789");
  }

  @Test
  @DisplayName("redaction is idempotent, so a retry cannot double-mask")
  void idempotent() {
    String once = PiiGuard.scan("my aadhaar is 2345 6789 0123").redacted();
    assertThat(PiiGuard.scan(once).redacted()).isEqualTo(once);
  }
}
