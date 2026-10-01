package in.bissaathi.common;

/**
 * Question intent, decided by the router in the rag module.
 *
 * Intent drives three things: which document types are eligible for retrieval, the
 * output token budget, and whether an answer is generated at all. CHITCHAT,
 * OUT_OF_SCOPE and META never reach a model; CLARIFY never retrieves.
 */
public enum Intent {
  factual,
  clarify,
  recommend,
  certification,
  hallmark,
  lab,
  compare,
  chitchat,
  out_of_scope,
  meta
}
