package in.bissaathi.auth;

import in.bissaathi.common.ApiException;
import in.bissaathi.common.AppProperties;
import in.bissaathi.common.ErrorCode;
import java.util.List;
import org.springframework.security.crypto.argon2.Argon2PasswordEncoder;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;

/**
 * Password hashing and policy (§8, feature #1).
 *
 * Argon2id is the default (memory-hard, so a GPU farm does not help much). BCrypt at
 * strength 12 is the documented fallback for an environment without BouncyCastle.
 * The scheme actually used is stored with the hash so an older hash can be upgraded
 * transparently on the next successful login — never on a schedule, and never
 * without the user present, because that would require keeping plaintext.
 *
 * Timing: verification always runs, even for an unknown email, so a login response
 * cannot be used to enumerate accounts.
 */
@Service
public class PasswordService {

  private final AppProperties properties;
  private final PasswordEncoder primary;
  private final PasswordEncoder fallback;

  public PasswordService(AppProperties properties) {
    this.properties = properties;
    AppProperties.Password.Argon2 argon2 = properties.password().argon2();
    this.primary =
        new Argon2PasswordEncoder(
            argon2.memoryKib(), argon2.iterations(), argon2.parallelism(), 16, 32);
    this.fallback = new BCryptPasswordEncoder(properties.password().bcryptStrength());
  }

  public String scheme() {
    return properties.password().scheme();
  }

  public String hash(String raw) {
    return encoderFor(scheme()).encode(raw);
  }

  /**
   * Verifies against the scheme recorded on the hash, not the currently configured
   * one, so changing PASSWORD_SCHEME does not log everybody out.
   */
  public boolean matches(String raw, String storedHash, String storedScheme) {
    if (raw == null || storedHash == null) return false;
    return encoderFor(storedScheme).matches(raw, storedHash);
  }

  /** True when the stored hash should be re-hashed with the current scheme/params. */
  public boolean needsRehash(String storedHash, String storedScheme) {
    if (!scheme().equalsIgnoreCase(storedScheme)) return true;
    return encoderFor(storedScheme).upgradeEncoding(storedHash);
  }

  /**
   * The password policy, and the authority for it.
   *
   * `Character.isLetter` / `isDigit` are Unicode-aware on purpose: a Devanagari
   * passphrase is valid. The client mirrors this with \p{L} / \p{N}; if either side
   * narrows to ASCII, a Hindi user is told their correct password is too weak, and
   * the failure looks like a login bug rather than a policy mismatch.
   *
   * The frontend mirrors these rules so a user is not sent a payload that will be
   * rejected, but it is not a control — removing the client copy must not change what
   * this method accepts.
   */
  public void validatePolicy(String raw) {
    int min = properties.password().minLength();
    int max = properties.password().maxLength();
    if (raw == null || raw.length() < min || raw.length() > max) {
      throw ApiException.validation(
          "Please check the highlighted fields.",
          List.of(new ApiException.FieldIssue("password", "Password is too weak.")));
    }
    boolean hasLetter = false;
    boolean hasNumber = false;
    for (int i = 0; i < raw.length(); i++) {
      char c = raw.charAt(i);
      if (Character.isLetter(c)) hasLetter = true;
      if (Character.isDigit(c)) hasNumber = true;
    }
    if (!hasLetter || !hasNumber) {
      throw ApiException.validation(
          "Please check the highlighted fields.",
          List.of(
              new ApiException.FieldIssue(
                  "password", "At least " + min + " characters, including a letter and a number.")));
    }
  }

  private PasswordEncoder encoderFor(String scheme) {
    if (scheme == null) return primary;
    return switch (scheme.toLowerCase()) {
      case "bcrypt" -> fallback;
      case "argon2id" -> primary;
      // An unknown scheme is a configuration bug, not a user error: fail loudly
      // rather than silently accepting a weaker comparison (R8).
      default ->
          throw new ApiException(
              ErrorCode.INTERNAL, "Unsupported password scheme configured: " + scheme);
    };
  }
}
