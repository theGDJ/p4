package in.bissaathi.rag;

import static org.assertj.core.api.Assertions.assertThat;

import in.bissaathi.common.Language;
import in.bissaathi.common.VerificationStatus;
import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * R3 — the citation gate. This class is the difference between a system that can
 * hallucinate a source and one that cannot, so the negative cases matter most.
 */
class CitationValidatorTest {

  private final CitationValidator validator = new CitationValidator();

  private static RetrievedChunk chunk(int index) {
    return new RetrievedChunk(
        "chunk-" + index,
        "ver-" + index,
        "IS 1234" + index + ":2020 — General requirements",
        "IS 1234" + index,
        "Clause " + index + ".1",
        "IS",
        Language.en,
        "https://bis.gov.in/standards/is-1234" + index,
        VerificationStatus.VERIFIED,
        Instant.parse("2026-01-0" + index + "T00:00:00Z"),
        "passage " + index,
        0.5);
  }

  @Test
  @DisplayName("a reference that was retrieved is kept")
  void keepsValidRefs() {
    CitationValidator.Result result =
        validator.validate("The requirement is in Clause 1.1 [S1].", List.of("S1"), List.of(chunk(1), chunk(2)));

    assertThat(result.sources()).hasSize(1);
    assertThat(result.droppedRefs()).isEmpty();
    assertThat(result.allCitationsValid()).isTrue();
  }

  @Test
  @DisplayName("a reference the model invented is dropped, not kept and annotated")
  void dropsInventedRefs() {
    CitationValidator.Result result =
        validator.validate("Per IS 99999 [S9] this is mandatory.", List.of("S9"), List.of(chunk(1)));

    assertThat(result.sources()).isEmpty();
    assertThat(result.droppedRefs()).containsExactly("S9");
    assertThat(result.allCitationsValid()).isFalse();
  }

  @Test
  @DisplayName("out-of-range and malformed refs are dropped")
  void dropsOutOfRange() {
    CitationValidator.Result result =
        validator.validate("See [S3] and [S0] and [x].", List.of("S7"), List.of(chunk(1), chunk(2)));

    assertThat(result.sources()).isEmpty();
    assertThat(result.droppedRefs()).contains("S3", "S7");
  }

  @Test
  @DisplayName("the same source cited two ways is counted once")
  void dedupesEquivalentRefs() {
    CitationValidator.Result result =
        validator.validate("Stated in [S1].", List.of("1", "S1"), List.of(chunk(1)));

    assertThat(result.sources()).hasSize(1);
  }

  @Test
  @DisplayName("source metadata comes from the row, never from the answer text")
  void metadataIsServerOwned() {
    // The model's prose claims a title that does not exist. The returned source still
    // carries the database title, because the DTO is built from RetrievedChunk.
    CitationValidator.Result result =
        validator.validate(
            "IS 12341:2020 — Totally Fabricated Title [S1]", List.of("S1"), List.of(chunk(1)));

    assertThat(result.sources()).singleElement()
        .satisfies(source -> {
          assertThat(source.title()).isEqualTo("IS 12341:2020 — General requirements");
          assertThat(source.standardNo()).isEqualTo("IS 12341");
        });
  }

  @Test
  @DisplayName("no citations at all yields no sources, so the tier cannot be STRONG")
  void noCitationsYieldsNothing() {
    CitationValidator.Result result = validator.validate("A fluent answer with no refs.", List.of(), List.of(chunk(1)));

    assertThat(result.sources()).isEmpty();
  }
}
