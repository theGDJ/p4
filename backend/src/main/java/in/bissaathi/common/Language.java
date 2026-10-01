package in.bissaathi.common;

/** Supported UI and content languages (§2 bilingual requirement). */
public enum Language {
  en,
  hi;

  /** Anything unrecognised falls back to English rather than failing the request. */
  public static Language from(String raw) {
    if (raw == null) return en;
    String normalized = raw.trim().toLowerCase();
    for (Language candidate : values()) {
      if (candidate.name().equals(normalized)) return candidate;
    }
    // A regional tag such as "hi-IN" still resolves to its base language.
    String base = normalized.split("-")[0];
    for (Language candidate : values()) {
      if (candidate.name().equals(base)) return candidate;
    }
    return en;
  }
}
