package in.bissaathi.auth;

import in.bissaathi.audit.AuditService;
import in.bissaathi.auth.dto.AuthDtos.AuthenticatedSession;
import in.bissaathi.auth.dto.AuthDtos.ChangePasswordRequest;
import in.bissaathi.auth.dto.AuthDtos.JwtToken;
import in.bissaathi.auth.dto.AuthDtos.LoginRequest;
import in.bissaathi.auth.dto.AuthDtos.MeResponse;
import in.bissaathi.auth.dto.AuthDtos.PublicUser;
import in.bissaathi.auth.dto.AuthDtos.RegisterRequest;
import in.bissaathi.auth.dto.AuthDtos.ResetPasswordRequest;
import in.bissaathi.auth.dto.AuthDtos.ResetRequestRequest;
import in.bissaathi.auth.dto.AuthDtos.ResetRequestResponse;
import in.bissaathi.auth.dto.AuthDtos.SessionResponse;
import in.bissaathi.common.ApiException;
import in.bissaathi.common.AppProperties;
import in.bissaathi.common.ErrorCode;
import in.bissaathi.common.Language;
import in.bissaathi.common.Role;
import in.bissaathi.domain.PasswordResetTokenEntity;
import in.bissaathi.domain.UserEntity;
import in.bissaathi.repo.ConversationRepository;
import in.bissaathi.repo.PasswordResetTokenRepository;
import in.bissaathi.repo.UserRepository;
import jakarta.servlet.http.HttpServletRequest;
import java.time.Duration;
import java.time.Instant;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Registration, login, lockout, refresh and password reset (§8, feature #1).
 *
 * Four rules shape every method here:
 *  - Login cost is constant. An unknown email still runs a hash verification against a
 *    dummy value, so response time does not reveal whether an account exists, and one
 *    error message covers both "no such account" and "wrong password".
 *  - Lockout is counted in the database, not in memory, so it survives a restart and
 *    applies across instances.
 *  - A password change or reset revokes every refresh token for the user. A stolen
 *    session must not outlive the password that authorised it.
 *  - Roles are assigned by the server and re-read on every request; nothing a client
 *    posts can influence them (§4).
 */
@Service
public class AuthService {

  private static final Logger log = LoggerFactory.getLogger(AuthService.class);

  private final UserRepository users;
  private final PasswordResetTokenRepository resetTokens;
  private final ConversationRepository conversations;
  private final PasswordService passwords;
  private final JwtService jwt;
  private final RefreshTokenService refreshTokens;
  private final RateLimitService rateLimit;
  private final AuditService audit;
  private final AppProperties properties;
  private final Environment environment;

  /**
   * A hash of a password nobody can be issued, verified against on unknown-email
   * logins purely to consume the same amount of CPU as a real verification.
   */
  private final String dummyHash;

  public AuthService(
      UserRepository users,
      PasswordResetTokenRepository resetTokens,
      ConversationRepository conversations,
      PasswordService passwords,
      JwtService jwt,
      RefreshTokenService refreshTokens,
      RateLimitService rateLimit,
      AuditService audit,
      AppProperties properties,
      Environment environment) {
    this.users = users;
    this.resetTokens = resetTokens;
    this.conversations = conversations;
    this.passwords = passwords;
    this.jwt = jwt;
    this.refreshTokens = refreshTokens;
    this.rateLimit = rateLimit;
    this.audit = audit;
    this.properties = properties;
    this.environment = environment;
    this.dummyHash = passwords.hash("dummy-password-for-timing-equalisation-9");
  }

  /* ------------------------------------------------------------------ register */

  @Transactional
  public AuthenticatedSession register(RegisterRequest request, HttpServletRequest http) {
    rateLimit.checkAuth("register:" + clientKey(http));
    String email = request.email().trim().toLowerCase();

    if (users.existsByEmailIgnoreCase(email)) {
      audit.record(null, "auth.register.conflict", "user", null, AuditService.DENIED, http, null);
      throw ApiException.conflict("An account with this email already exists.");
    }

    passwords.validatePolicy(request.password());

    UserEntity user =
        new UserEntity(email, passwords.hash(request.password()), passwords.scheme(), request.fullName().trim());
    user.setPersona(request.persona());
    user.setLanguage(request.language() == null ? Language.en : request.language());
    // Always USER, granted by the server. There is no code path by which a request
    // body influences a role: the register DTO has no roles field at all.
    user.grantRole(Role.USER);
    users.save(user);

    audit.recordFor(user, "auth.register", "user", user.getId().toString(), AuditService.SUCCESS, http, null);
    return startSession(user, http);
  }

  /* --------------------------------------------------------------------- login */

  @Transactional
  public AuthenticatedSession login(LoginRequest request, HttpServletRequest http) {
    rateLimit.checkAuth("login:" + clientKey(http));
    Instant now = Instant.now();
    String email = request.email().trim().toLowerCase();

    UserEntity user = users.findByEmailIgnoreCase(email).orElse(null);
    if (user == null) {
      passwords.matches(request.password(), dummyHash, passwords.scheme());
      audit.record(null, "auth.login.unknown_email", "user", null, AuditService.DENIED, http, null);
      throw invalidCredentials();
    }

    if (user.isLocked(now)) {
      long retryAfter = Math.max(1, Duration.between(now, user.getLockedUntil()).getSeconds());
      audit.recordFor(user, "auth.login.locked", "user", user.getId().toString(), AuditService.DENIED, http, null);
      throw ApiException.locked("Too many failed sign-in attempts. Try again later.", String.valueOf(retryAfter));
    }

    if (!passwords.matches(request.password(), user.getPasswordHash(), user.getPasswordScheme())) {
      user.registerFailedAttempt(properties.lockout().maxFailedAttempts(), properties.lockout().lockMinutes(), now);
      users.save(user);
      audit.recordFor(
          user,
          "auth.login.failed",
          "user",
          user.getId().toString(),
          AuditService.DENIED,
          http,
          "{\"failedAttempts\":" + user.getFailedLoginAttempts() + "}");
      if (user.isLocked(now)) {
        throw ApiException.locked(
            "Too many failed sign-in attempts. Try again later.",
            String.valueOf(properties.lockout().lockMinutes() * 60L));
      }
      throw invalidCredentials();
    }

    user.registerSuccessfulLogin(now);
    // Transparent upgrade: if the stored hash used an older scheme or weaker
    // parameters, re-hash now that the plaintext is legitimately in hand. This is
    // the only moment it is possible, which is why no background job does it.
    if (passwords.needsRehash(user.getPasswordHash(), user.getPasswordScheme())) {
      user.setPasswordHash(passwords.hash(request.password()));
      user.setPasswordScheme(passwords.scheme());
      log.info("password hash upgraded on login for user {}", user.getId());
    }
    users.save(user);

    audit.recordFor(user, "auth.login.success", "user", user.getId().toString(), AuditService.SUCCESS, http, null);
    return startSession(user, http);
  }

  /* ------------------------------------------------------------------- refresh */

  /**
   * Exchanges the cookie's refresh token for a new access token and a rotated refresh
   * token. Roles are re-read here, so a revoked role takes effect at the next refresh
   * rather than up to 15 minutes later.
   *
   * Reuse detection lives in {@link RefreshTokenService#rotate}; a replayed token
   * surfaces here as REFRESH_REUSED and the whole family is already revoked by then.
   */
  @Transactional
  public AuthenticatedSession refresh(String presentedRefreshToken, HttpServletRequest http) {
    RefreshTokenService.Rotation rotation = refreshTokens.rotate(presentedRefreshToken, http);
    UserEntity user =
        users.findById(rotation.userId()).orElseThrow(() -> ApiException.unauthenticated("No session"));

    if (user.isLocked(Instant.now())) {
      // A locked account may not extend its sessions.
      refreshTokens.revokeAllForUser(user.getId(), "auth.refresh.locked", http);
      throw ApiException.locked("Too many failed sign-in attempts. Try again later.", "900");
    }

    return new AuthenticatedSession(
        SessionResponse.of(PublicUser.of(user), issueAccess(user)), rotation.refreshToken());
  }

  /* -------------------------------------------------------------------- logout */

  @Transactional
  public void logout(String presentedRefreshToken, HttpServletRequest http) {
    if (presentedRefreshToken != null && !presentedRefreshToken.isBlank()) {
      refreshTokens.revokeFamilyOf(presentedRefreshToken, http);
    }
    // Deliberately 204 whether or not a cookie was present: logout is idempotent and
    // an absent cookie is not an error worth telling a caller about.
  }

  /* -------------------------------------------------------------- password reset */

  @Transactional
  public ResetRequestResponse requestPasswordReset(ResetRequestRequest request, HttpServletRequest http) {
    rateLimit.checkAuth("reset:" + clientKey(http));
    String email = request.email().trim().toLowerCase();

    // One message, returned on both paths, so this endpoint cannot enumerate accounts.
    String constantMessage =
        "If an account exists for that address, a reset link is on its way. Links expire after "
            + properties.password().resetTokenTtlMinutes()
            + " minutes.";

    UserEntity user = users.findByEmailIgnoreCase(email).orElse(null);
    if (user == null) {
      audit.record(null, "auth.reset.unknown_email", "user", null, AuditService.SUCCESS, http, null);
      return new ResetRequestResponse(true, constantMessage, null);
    }

    String raw = TokenHasher.newResetToken();
    resetTokens.save(
        new PasswordResetTokenEntity(
            user.getId(),
            TokenHasher.sha256(raw),
            Instant.now().plusSeconds(properties.password().resetTokenTtlMinutes() * 60L),
            http == null ? null : http.getRemoteAddr()));
    audit.recordFor(user, "auth.reset.requested", "user", user.getId().toString(), AuditService.SUCCESS, http, null);

    if (isProduction()) {
      // A mail transport is wired in P2. Until it exists the token is generated and
      // simply not delivered — never echoed back over HTTP, which would hand a
      // caller a credential and defeat the mechanism (R8: say so in the log).
      log.warn("no mail provider configured; reset token generated for {} was not delivered", user.getId());
      return new ResetRequestResponse(true, constantMessage, null);
    }
    // Development only: lets the flow be completed by hand and be tested end to end.
    return new ResetRequestResponse(true, constantMessage, raw);
  }

  @Transactional
  public void resetPassword(ResetPasswordRequest request, HttpServletRequest http) {
    PasswordResetTokenEntity token =
        resetTokens
            .findByTokenHash(TokenHasher.sha256(request.token()))
            .orElseThrow(() -> invalidResetLink());

    Instant now = Instant.now();
    if (!token.isUsable(now)) {
      audit.record(token.getUserId(), "auth.reset.invalid", "user", token.getUserId().toString(),
          AuditService.DENIED, http, null);
      throw invalidResetLink();
    }

    UserEntity user =
        users.findById(token.getUserId()).orElseThrow(AuthService::invalidResetLink);
    passwords.validatePolicy(request.password());

    user.setPasswordHash(passwords.hash(request.password()));
    user.setPasswordScheme(passwords.scheme());
    user.registerSuccessfulLogin(now);
    users.save(user);
    // Single use: marked used rather than deleted, so a replay is distinguishable
    // from a nonexistent token in the audit trail.
    token.markUsed(now);
    resetTokens.save(token);

    int revoked = refreshTokens.revokeAllForUser(user.getId(), "auth.reset.completed", http);
    log.info("password reset for {} revoked {} refresh token(s)", user.getId(), revoked);
  }

  /* ----------------------------------------------------------- change password */

  @Transactional
  public void changePassword(UUID userId, ChangePasswordRequest request, HttpServletRequest http) {
    UserEntity user = users.findById(userId).orElseThrow(() -> ApiException.unauthenticated("Authentication required."));
    if (!passwords.matches(request.currentPassword(), user.getPasswordHash(), user.getPasswordScheme())) {
      audit.recordFor(user, "auth.password_change.wrong_current", "user", user.getId().toString(),
          AuditService.DENIED, http, null);
      throw invalidCredentials();
    }
    passwords.validatePolicy(request.newPassword());
    user.setPasswordHash(passwords.hash(request.newPassword()));
    user.setPasswordScheme(passwords.scheme());
    users.save(user);
    // Every session is revoked, including the one that just changed the password.
    // Forcing a re-login is the correct cost of a credential change; keeping the
    // attacker's still-valid cookie alive alongside it is not.
    refreshTokens.revokeAllForUser(user.getId(), "auth.password_change.completed", http);
  }

  /* ---------------------------------------------------------------------- read */

  /** Loads a user for the authorization filter; roles come from this entity. */
  @Transactional(readOnly = true)
  public UserEntity loadForAuthorization(UUID userId) {
    return users.findById(userId).orElseThrow(() -> ApiException.unauthenticated("Authentication required."));
  }

  @Transactional(readOnly = true)
  public MeResponse me(UUID userId) {
    UserEntity user = users.findById(userId).orElseThrow(() -> ApiException.unauthenticated("Authentication required."));
    return MeResponse.of(user, conversations.countForUser(user.getId()));
  }

  /* ------------------------------------------------------------------- private */

  private AuthenticatedSession startSession(UserEntity user, HttpServletRequest http) {
    String refresh = refreshTokens.issueNewFamily(user, http);
    return new AuthenticatedSession(SessionResponse.of(PublicUser.of(user), issueAccess(user)), refresh);
  }

  private JwtToken issueAccess(UserEntity user) {
    JwtService.IssuedToken issued = jwt.issue(user, user.roles());
    return new JwtToken(issued.accessToken(), issued.accessExpiresAt(), issued.expiresInSeconds());
  }

  /**
   * One message for every credential failure. Revealing which half was wrong turns
   * the login form into an account-enumeration oracle.
   */
  private static ApiException invalidCredentials() {
    return new ApiException(ErrorCode.INVALID_CREDENTIALS, "Incorrect email or password.");
  }

  /** Same for reset links: "no such token" and "already used" must be identical. */
  private static ApiException invalidResetLink() {
    return ApiException.unauthenticated("Reset link is invalid or has expired.");
  }

  private static String clientKey(HttpServletRequest request) {
    return request == null ? "unknown" : String.valueOf(request.getRemoteAddr());
  }

  private boolean isProduction() {
    for (String profile : environment.getActiveProfiles()) {
      if (profile.equalsIgnoreCase("prod") || profile.equalsIgnoreCase("production")) return true;
    }
    return false;
  }
}
