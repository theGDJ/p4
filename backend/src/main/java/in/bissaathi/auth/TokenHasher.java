package in.bissaathi.auth;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.HexFormat;

/**
 * Opaque token generation and hashing.
 *
 * Refresh and password-reset tokens are high-entropy random strings, not JWTs: there
 * is nothing in them to read, and only their SHA-256 digest is stored, so a database
 * leak does not yield usable credentials. Comparisons are constant-time.
 */
public final class TokenHasher {

  private static final SecureRandom RANDOM = new SecureRandom();
  private static final HexFormat HEX = HexFormat.of();

  private TokenHasher() {}

  /** 48 random bytes -> 64 characters of base64url, no padding. */
  public static String newRefreshToken() {
    byte[] bytes = new byte[48];
    RANDOM.nextBytes(bytes);
    return java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
  }

  /** 32 random bytes -> hex, for a reset token that has to survive a URL. */
  public static String newResetToken() {
    byte[] bytes = new byte[32];
    RANDOM.nextBytes(bytes);
    return HEX.formatHex(bytes);
  }

  public static String sha256(String token) {
    try {
      MessageDigest digest = MessageDigest.getInstance("SHA-256");
      return HEX.formatHex(digest.digest(token.getBytes(StandardCharsets.UTF_8)));
    } catch (NoSuchAlgorithmException e) {
      // SHA-256 is mandated by the JCA specification; this cannot happen.
      throw new IllegalStateException("SHA-256 unavailable", e);
    }
  }

  /** Constant-time comparison, so a guess cannot be refined byte by byte. */
  public static boolean equals(String a, String b) {
    if (a == null || b == null) return false;
    return MessageDigest.isEqual(
        a.getBytes(StandardCharsets.UTF_8), b.getBytes(StandardCharsets.UTF_8));
  }
}
