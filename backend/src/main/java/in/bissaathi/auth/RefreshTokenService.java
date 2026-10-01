package in.bissaathi.auth;

import in.bissaathi.audit.AuditService;
import in.bissaathi.common.ApiException;
import in.bissaathi.common.AppProperties;
import in.bissaathi.common.ErrorCode;
import in.bissaathi.domain.RefreshTokenEntity;
import in.bissaathi.domain.UserEntity;
import in.bissaathi.repo.RefreshTokenRepository;
import jakarta.servlet.http.HttpServletRequest;
import java.time.Instant;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Refresh-token rotation with reuse detection (§8, feature #1).
 *
 * The scheme:
 *   1. A token belongs to a family, created at login.
 *   2. Presenting a live token marks it used and issues a replacement in the same
 *      family. The old token is never valid again.
 *   3. Presenting an ALREADY-USED token means either the cookie was copied or a
 *      response was replayed. The whole family is revoked and the caller gets
 *      REFRESH_REUSED. Every session that descended from that login dies.
 *
 * Revoking the family rather than the single token is the point: an attacker holding
 * a stolen cookie cannot keep rotating ahead of the legitimate user.
 */
@Service
public class RefreshTokenService {

  private final RefreshTokenRepository repository;
  private final AppProperties properties;
  private final AuditService audit;

  public RefreshTokenService(RefreshTokenRepository repository, AppProperties properties, AuditService audit) {
    this.repository = repository;
    this.properties = properties;
    this.audit = audit;
  }

  /** Starts a new family — called at login and registration. */
  public String issueNewFamily(UserEntity user, HttpServletRequest request) {
    return issue(user.getId(), UUID.randomUUID(), request).raw();
  }

  /** Creates one token row. Callers are already inside a transaction. */
  private IssuedRefresh issue(UUID userId, UUID familyId, HttpServletRequest request) {
    String raw = TokenHasher.newRefreshToken();
    Instant now = Instant.now();
    RefreshTokenEntity entity =
        new RefreshTokenEntity(
            userId,
            familyId,
            TokenHasher.sha256(raw),
            now.plusSeconds(properties.refresh().ttlDays() * 86_400L),
            userAgent(request),
            clientIp(request));
    repository.save(entity);
    return new IssuedRefresh(entity.getId(), raw);
  }

  /**
   * Exchanges a presented token for a fresh one in the same family.
   *
   * @throws ApiException REFRESH_REUSED when the token was already spent,
   *     UNAUTHENTICATED when it is unknown, expired or revoked.
   */
  @Transactional
  public Rotation rotate(String presentedToken, HttpServletRequest request) {
    Instant now = Instant.now();
    String hash = TokenHasher.sha256(presentedToken);
    RefreshTokenEntity token =
        repository.findByTokenHash(hash).orElseThrow(() -> ApiException.unauthenticated("No session"));

    if (token.isUsed()) {
      // REUSE DETECTION. Revoke the entire family, then report it.
      int revoked = repository.revokeFamily(token.getFamilyId(), now);
      audit.record(
          token.getUserId(),
          "auth.refresh.reused",
          "refresh_token_family",
          token.getFamilyId().toString(),
          AuditService.DENIED,
          request,
          "{\"tokensRevoked\":" + revoked + "}");
      throw new ApiException(
          ErrorCode.REFRESH_REUSED,
          "This session has been ended for your security. Please sign in again.");
    }

    if (token.getRevokedAt() != null) {
      throw ApiException.unauthenticated("Session ended");
    }
    if (token.getExpiresAt().isBefore(now)) {
      throw new ApiException(ErrorCode.TOKEN_EXPIRED, "Your session expired. Please sign in again.");
    }

    IssuedRefresh replacement = issue(token.getUserId(), token.getFamilyId(), request);
    token.markUsed(now, replacement.id());
    repository.save(token);

    audit.record(
        token.getUserId(),
        "auth.refresh.rotated",
        "refresh_token",
        token.getId().toString(),
        AuditService.SUCCESS,
        request,
        null);
    return new Rotation(token.getUserId(), replacement.raw());
  }

  /** Ends one family (logout). */
  @Transactional
  public void revokeFamilyOf(String presentedToken, HttpServletRequest request) {
    repository
        .findByTokenHash(TokenHasher.sha256(presentedToken))
        .ifPresent(
            token -> {
              int revoked = repository.revokeFamily(token.getFamilyId(), Instant.now());
              audit.record(
                  token.getUserId(),
                  "auth.logout",
                  "refresh_token_family",
                  token.getFamilyId().toString(),
                  AuditService.SUCCESS,
                  request,
                  "{\"tokensRevoked\":" + revoked + "}");
            });
  }

  /** Ends every session for a user — after a password change or reset (§8). */
  @Transactional
  public int revokeAllForUser(UUID userId, String action, HttpServletRequest request) {
    int revoked = repository.revokeAllForUser(userId, Instant.now());
    audit.record(userId, action, "user", userId.toString(), AuditService.SUCCESS, request,
        "{\"tokensRevoked\":" + revoked + "}");
    return revoked;
  }

  public int ttlSeconds() {
    return properties.refresh().ttlDays() * 86_400;
  }

  private static String userAgent(HttpServletRequest request) {
    if (request == null) return null;
    String header = request.getHeader("User-Agent");
    return header == null ? null : header.substring(0, Math.min(header.length(), 512));
  }

  private static String clientIp(HttpServletRequest request) {
    if (request == null) return null;
    // `forward-headers-strategy: framework` means getRemoteAddr() already reflects
    // X-Forwarded-For when the request came through the proxy.
    return request.getRemoteAddr();
  }

  public record Rotation(UUID userId, String refreshToken) {}

  private record IssuedRefresh(UUID id, String raw) {}
}
