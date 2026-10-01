package in.bissaathi.common;

/**
 * Evidence strength for an answer (§5, feature #3).
 *
 * The tier is computed by rule from the retrieved, citation-validated evidence set.
 * It is never self-reported by the model: a model rating its own confidence is not
 * evidence, and R10 forbids presenting one as if it were.
 */
public enum EvidenceTier {
  /** Two or more approved chunks above the score threshold, every citation valid. */
  STRONG,
  /** At least one usable source, or some citations failed validation. */
  PARTIAL,
  /** Nothing retrieved, or nothing survived citation validation. */
  NONE
}
