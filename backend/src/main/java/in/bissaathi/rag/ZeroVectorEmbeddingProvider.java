package in.bissaathi.rag;

import org.springframework.stereotype.Component;

/** Deterministic, honest embedding stand-in. See {@link EmbeddingProvider}. */
@Component
public class ZeroVectorEmbeddingProvider implements EmbeddingProvider {

  private static final int DIMENSIONS = 1024;

  @Override
  public int dimensions() {
    return DIMENSIONS;
  }

  @Override
  public float[] embed(String text) {
    // All-zero: cosine similarity is undefined, so no candidate can clear the
    // evidence threshold and every answer falls through to the R4 path.
    return new float[DIMENSIONS];
  }

  @Override
  public String name() {
    return "mock-zero-vector";
  }

  @Override
  public boolean isMock() {
    return true;
  }
}
