package in.bissaathi.rag;

/**
 * Embeddings behind an interface (§3: the model must be multilingual so a Hindi
 * question can retrieve an English document and vice versa).
 *
 * The default implementation is deterministic and deliberately useless for real
 * retrieval: it returns a zero vector, which makes every cosine score 0 and forces
 * the pipeline down the "nothing retrieved" path. That is the honest mock. A
 * provider that invented plausible-looking similarity scores would let a test pass
 * for a reason that does not exist in production (R10).
 */
public interface EmbeddingProvider {

  /** Dimensionality must match knowledge_chunks.embedding, or the insert fails. */
  int dimensions();

  float[] embed(String text);

  String name();

  boolean isMock();
}
