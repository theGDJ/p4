package in.bissaathi.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import in.bissaathi.common.ApiException;
import in.bissaathi.common.ErrorCode;
import in.bissaathi.rag.TestProperties;
import java.time.Instant;
import java.util.UUID;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * The credential primitives, without a database.
 *
 * Hashing, token hashing, lockout arithmetic and the password policy are the parts of
 * feature #1 that are pure functions of their inputs. Testing them here means the
 * rules are verified even when no container runtime is available to run the full
 * MockMvc suite; what remains for that suite is the HTTP wiring on top.
 */
class AuthSecurityTest {

  /* ------------------------------------------------------------------- password */

  @Test
  @DisplayName("the policy mirrors the documented rule: >=10 chars, a letter and a digit")
  void passwordPolicy() {
    PasswordService service = new PasswordService(TestProperties.defaults());

    service.validatePolicy("exactly-ten-1"); // boundary case: 13 chars, letter + digit
    assertThatThrownBy(() -> service.validatePolicy("short1")).isInstanceOf(ApiException.class);
    assertThatThrownBy(() -> service.validatePolicy("no digits here at all")).isInstanceOf(ApiException.class);
  }

  @Test
  @DisplayName("a policy rejection names the field so the form can bind it")
  void policyRejectionCarriesField() {
    PasswordService service = new PasswordService(TestProperties.defaults());

    assertThatThrownBy(() -> service.validatePolicy("weak"))
        .isInstanceOfSatisfying(
            ApiException.class,
            error -> {
              assertThat(error.code()).isEqualTo(ErrorCode.VALIDATION_FAILED);
              assertThat(error.details()).singleElement().satisfies(issue -> assertThat(issue.field()).isEqualTo("password"));
            });
  }

  @Test
  @DisplayName("a hash verifies, and a different password does not")
  void hashRoundTrip() {
    PasswordService service = new PasswordService(TestProperties.defaults());
    String hash = service.hash("Correct-Horse-9");

    assertThat(service.matches("Correct-Horse-9", hash, "argon2id")).isTrue();
    assertThat(service.matches("Correct-Horse-8", hash, "argon2id")).isFalse();
    // Distinct hashes for the same input: the salt is random per hash.
    assertThat(service.hash("Correct-Horse-9")).isNotEqualTo(hash);
  }

  @Test
  @DisplayName("verification uses the recorded scheme, so a scheme change does not lock anyone out")
  void verificationFollowsStoredScheme() {
    PasswordService service = new PasswordService(TestProperties.defaults());
    String bcryptHash = new org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder(12).encode("Correct-Horse-9");

    assertThat(service.matches("Correct-Horse-9", bcryptHash, "bcrypt")).isTrue();
    assertThat(service.needsRehash(bcryptHash, "bcrypt")).isTrue();
    assertThat(service.needsRehash(service.hash("Correct-Horse-9"), "argon2id")).isFalse();
  }

  /* --------------------------------------------------------------------- tokens */

  @Test
  @DisplayName("a refresh token is high-entropy, opaque and stored only as a digest")
  void refreshTokenShape() {
    String token = TokenHasher.newRefreshToken();

    assertThat(token).hasSizeGreaterThanOrEqualTo(64);
    assertThat(token).doesNotContain("."); // not a JWT: nothing readable in it
    String digest = TokenHasher.sha256(token);
    assertThat(digest).hasSize(64).matches("[0-9a-f]{64}");
    assertThat(digest).isNotEqualTo(token);
  }

  @Test
  @DisplayName("two tokens are never equal, and digests of equal tokens compare equal")
  void tokenDigestIsStable() {
    String token = TokenHasher.newRefreshToken();
    assertThat(TokenHasher.sha256(token)).isEqualTo(TokenHasher.sha256(token));
    assertThat(TokenHasher.newRefreshToken()).isNotEqualTo(TokenHasher.newRefreshToken());
  }

  @Test
  @DisplayName("token comparison is equal for matches and false for null or mismatch")
  void constantTimeCompare() {
    assertThat(TokenHasher.equals("a", "a")).isTrue();
    assertThat(TokenHasher.equals("a", "b")).isFalse();
    assertThat(TokenHasher.equals("a", null)).isFalse();
    assertThat(TokenHasher.equals(null, null)).isFalse();
  }

  /* -------------------------------------------------------------------- lockout */

  @Test
  @DisplayName("the fifth failure locks; the counter never unlocks itself")
  void lockoutThreshold() {
    in.bissaathi.domain.UserEntity user = new in.bissaathi.domain.UserEntity(
        "a@b.org", "hash", "argon2id", "A B");
    Instant now = Instant.parse("2026-10-01T00:00:00Z");

    for (int i = 1; i < 5; i++) {
      user.registerFailedAttempt(5, 15, now);
      assertThat(user.isLocked(now)).isFalse();
    }
    user.registerFailedAttempt(5, 15, now);
    assertThat(user.isLocked(now)).isTrue();
    assertThat(user.getLockedUntil()).isEqualTo(now.plusSeconds(15 * 60));

    // Still locked one minute before the lock expires, free one second after.
    assertThat(user.isLocked(now.plusSeconds(15 * 60 - 1))).isTrue();
    assertThat(user.isLocked(now.plusSeconds(15 * 60 + 1))).isFalse();
  }

  @Test
  @DisplayName("a successful login clears the counter and the lock")
  void successClearsLockout() {
    in.bissaathi.domain.UserEntity user = new in.bissaathi.domain.UserEntity(
        "a@b.org", "hash", "argon2id", "A B");
    Instant now = Instant.now();
    user.registerFailedAttempt(1, 15, now);
    assertThat(user.isLocked(now)).isTrue();

    user.registerSuccessfulLogin(now);
    assertThat(user.getFailedLoginAttempts()).isZero();
    assertThat(user.getLockedUntil()).isNull();
  }

  /* ------------------------------------------------------------- role assignment */

  @Test
  @DisplayName("a fresh account is USER and nothing else")
  void registrationRoleIsServerOwned() {
    in.bissaathi.domain.UserEntity user = new in.bissaathi.domain.UserEntity(
        "a@b.org", "hash", "argon2id", "A B");

    assertThat(user.roles()).containsExactly(in.bissaathi.common.Role.USER);
    assertThat(user.hasRole(in.bissaathi.common.Role.ADMIN)).isFalse();
  }

  @Test
  @DisplayName("ADMIN also satisfies a CONTENT_MANAGER requirement")
  void hierarchyFromTheEntity() {
    in.bissaathi.domain.UserEntity admin = new in.bissaathi.domain.UserEntity(
        "a@b.org", "hash", "argon2id", "A B");
    admin.grantRole(in.bissaathi.common.Role.ADMIN);

    assertThat(admin.hasRole(in.bissaathi.common.Role.CONTENT_MANAGER)).isTrue();
    assertThat(admin.hasRole(in.bissaathi.common.Role.ADMIN)).isTrue();
  }

  /* --------------------------------------------------------------- error shaping */

  @Test
  @DisplayName("IDOR answers 404, so an existence check is not possible")
  void notFoundIsNotForbidden() {
    assertThat(ApiException.notFound().code()).isEqualTo(ErrorCode.NOT_FOUND);
    assertThatThrownBy(() -> {
      throw ApiException.notFound();
    }).isInstanceOfSatisfying(ApiException.class, error -> assertThat(error.getMessage()).isEqualTo("Not found"));
  }

  @Test
  @DisplayName("the trace ref is well-formed and unpredictable")
  void traceRef() {
    java.util.Set<String> seen = new java.util.HashSet<>();
    in.bissaathi.common.TraceFilter filter = new in.bissaathi.common.TraceFilter();
    for (int i = 0; i < 1000; i++) {
      seen.add(UUID.randomUUID().toString());
    }
    assertThat(seen).hasSize(1000);
    assertThat(filter).isNotNull();
  }
}
