package in.bissaathi.rag;

import in.bissaathi.common.Language;
import in.bissaathi.common.VerificationStatus;
import java.time.Instant;

/**
 * One retrieved passage, carrying everything a citation needs.
 *
 * Every field except {@code score} and {@code text} is copied from the database row.
 * That is the whole point of this record: it is the boundary at which model output
 * stops and evidence begins, so the API layer can build a source list from this alone
 * without touching the answer text (R3).
 */
public record RetrievedChunk(
    String chunkId,
    String documentVersionId,
    String title,
    String standardNo,
    String section,
    String docType,
    Language language,
    String sourceUrl,
    VerificationStatus verificationStatus,
    Instant verifiedAt,
    String text,
    double score) {

  /** A ~400-character window around the match, for the evidence rail. */
  public String snippet() {
    if (text == null) return "";
    String trimmed = text.strip();
    return trimmed.length() <= 400 ? trimmed : trimmed.substring(0, 400).stripTrailing() + "…";
  }
}
