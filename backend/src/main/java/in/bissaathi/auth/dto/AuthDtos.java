package in.bissaathi.auth.dto;

import in.bissaathi.common.Language;
import in.bissaathi.common.Persona;
import in.bissaathi.common.Role;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import in.bissaathi.domain.UserEntity;
import java.time.Instant;
import java.util.Set;
import java.util.UUID;

/**
 * Request and response shapes for the auth module (docs/API.md).
 *
 * Records, so a response cannot accidentally expose a mutable entity, and a request
 * cannot carry a field that was not declared. An unknown JSON key is rejected by the
 * ObjectMapper before it reaches a handler — that is what stops a client from
 * posting {@code roles: ["ADMIN"]} at registration (§8 privilege escalation).
 */
public final class AuthDtos {

  private AuthDtos() {}

  public record RegisterRequest(
      @NotBlank @Size(max = 120) String fullName,
      @NotBlank @Email @Size(max = 254) String email,
      @NotBlank @Size(min = 10, max = 200) String password,
      Persona persona,
      Language language) {}

  public record LoginRequest(
      @NotBlank @Email @Size(max = 254) String email,
      @NotBlank @Size(max = 200) String password) {}

  /**
   * The public view of an account. Never carries the hash or the lockout counters,
   * and emailVerified is read-only from a client's point of view.
   */
  public record PublicUser(
      UUID id,
      String email,
      String fullName,
      Persona persona,
      Language language,
      Set<Role> roles,
      boolean emailVerified,
      Instant createdAt) {

    public static PublicUser of(UserEntity user) {
      return new PublicUser(
          user.getId(),
          user.getEmail(),
          user.getFullName(),
          user.getPersona(),
          user.getLanguage(),
          user.roles(),
          user.isEmailVerified(),
          user.getCreatedAt());
    }
  }

  /** GET /users/me adds the fields the account holder may see about themselves. */
  public record MeResponse(
      UUID id,
      String email,
      String fullName,
      Persona persona,
      Language language,
      Set<Role> roles,
      boolean emailVerified,
      Instant createdAt,
      boolean locked,
      long conversationCount) {

    /** `locked` is derived, never stored, so it cannot go stale. */
    public static MeResponse of(UserEntity user, long conversationCount) {
      return new MeResponse(
          user.getId(),
          user.getEmail(),
          user.getFullName(),
          user.getPersona(),
          user.getLanguage(),
          user.roles(),
          user.isEmailVerified(),
          user.getCreatedAt(),
          user.isLocked(Instant.now()),
          conversationCount);
    }
  }

  public record JwtToken(String accessToken, Instant accessExpiresAt, int expiresIn) {}

  public record SessionResponse(
      PublicUser user, String accessToken, Instant accessExpiresAt, String tokenType, int expiresIn) {

    public static SessionResponse of(PublicUser user, JwtToken token) {
      return new SessionResponse(user, token.accessToken(), token.accessExpiresAt(), "Bearer", token.expiresIn());
    }
  }

  public record ResetRequestRequest(@NotBlank @Email @Size(max = 254) String email) {}

  /**
   * 202 with the same body whether or not the address is registered. `accepted` names
   * what actually happened — the request was accepted — rather than promising that an
   * email was sent, which is a claim this build cannot make until a mail provider is
   * wired up (R10).
   */
  public record ResetRequestResponse(
      boolean accepted,
      String message,
      /**
       * Populated ONLY in development when no mail provider is configured, so the
       * flow can be completed by hand. Production must leave this null: returning a
       * live reset token over HTTP would defeat the whole mechanism.
       */
      String devToken) {}

  public record ResetPasswordRequest(
      @NotBlank @Size(min = 20, max = 200) String token,
      @NotBlank @Size(min = 10, max = 200) String password) {}

  public record ChangePasswordRequest(
      @NotBlank String currentPassword, @NotBlank @Size(min = 10, max = 200) String newPassword) {}

  public record PatchMeRequest(
      @Size(max = 120) String fullName, Persona persona, Language language) {}

  /**
   * A response body plus the refresh token that must be written to the cookie.
   *
   * They are returned together so the controller cannot send a session body whose
   * cookie was forgotten, and the raw token never enters the JSON body at all — it
   * is only ever carried in the HttpOnly cookie.
   */
  public record AuthenticatedSession(SessionResponse body, String refreshToken) {}
}
