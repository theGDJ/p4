package in.bissaathi.common;

/**
 * Provenance and currency of a source (§7, R2/R7).
 *
 * SUPERSEDED documents are excluded from retrieval: an answer built on a withdrawn
 * revision is a wrong answer that looks right, which is the failure mode this
 * project exists to avoid.
 */
public enum VerificationStatus {
  VERIFIED,
  UNVERIFIED,
  OUTDATED,
  SUPERSEDED,
  /** Metadata-only; the text is never stored or reproduced (R11). */
  RESTRICTED
}
