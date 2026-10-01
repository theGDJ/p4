package in.bissaathi.auth;

import in.bissaathi.auth.dto.AuthDtos.AuthenticatedSession;
import in.bissaathi.auth.dto.AuthDtos.ChangePasswordRequest;
import in.bissaathi.auth.dto.AuthDtos.LoginRequest;
import in.bissaathi.auth.dto.AuthDtos.RegisterRequest;
import in.bissaathi.auth.dto.AuthDtos.ResetPasswordRequest;
import in.bissaathi.auth.dto.AuthDtos.ResetRequestRequest;
import in.bissaathi.auth.dto.AuthDtos.ResetRequestResponse;
import in.bissaathi.auth.dto.AuthDtos.SessionResponse;
import in.bissaathi.common.AppProperties;
import in.bissaathi.config.RequestContextHolder;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.Valid;
import java.time.Instant;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseCookie;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The auth endpoints (docs/API.md, "auth").
 *
 * The controller owns exactly one thing the service does not: the refresh cookie.
 * Setting it here keeps the HTTP concerns (attributes, SameSite, Path scope, Max-Age)
 * in one file, so the security-critical flag list can be read and reviewed without
 * also reading the credential logic.
 *
 * The refresh token is never present in a response body. A client that can read the
 * body is a client that can read JavaScript, and an accessible refresh token defeats
 * the reason it is HttpOnly.
 */
@RestController
@RequestMapping("/api/v1/auth")
public class AuthController {

  private final AuthService service;
  private final AppProperties properties;

  public AuthController(AuthService service, AppProperties properties) {
    this.service = service;
    this.properties = properties;
  }

  @PostMapping("/register")
  public ResponseEntity<SessionResponse> register(
      @Valid @RequestBody RegisterRequest request, HttpServletRequest http, HttpServletResponse response) {
    AuthenticatedSession session = service.register(request, http);
    writeRefreshCookie(response, session.refreshToken(), session.body().accessExpiresAt());
    return ResponseEntity.status(HttpStatus.CREATED).body(session.body());
  }

  @PostMapping("/login")
  public SessionResponse login(
      @Valid @RequestBody LoginRequest request, HttpServletRequest http, HttpServletResponse response) {
    AuthenticatedSession session = service.login(request, http);
    writeRefreshCookie(response, session.refreshToken(), session.body().accessExpiresAt());
    return session.body();
  }

  /**
   * Rotates the session.
   *
   * The token is read from the cookie, never from the body: a client that could put
   * it in a JSON field would also be able to send somebody else's. A caller
   * presenting both a cookie and a body field gets the cookie, and the discrepancy is
   * not acknowledged in the response.
   */
  @PostMapping("/refresh")
  public SessionResponse refresh(HttpServletRequest http, HttpServletResponse response) {
    String presented = readRefreshCookie(http);
    if (presented == null || presented.isBlank()) {
      throw in.bissaathi.common.ApiException.unauthenticated("No session");
    }
    AuthenticatedSession session = service.refresh(presented, http);
    writeRefreshCookie(response, session.refreshToken(), session.body().accessExpiresAt());
    return session.body();
  }

  /** Always 204, including when no cookie was present. Logout is idempotent. */
  @PostMapping("/logout")
  public ResponseEntity<Void> logout(HttpServletRequest http, HttpServletResponse response) {
    service.logout(readRefreshCookie(http), http);
    clearRefreshCookie(response);
    return ResponseEntity.noContent().build();
  }

  /**
   * 202 Accepted, not 200 OK: the request has been taken on board and the delivery is
   * somebody else's job. Returning 200 would imply the message was sent, which is not a
   * claim this build can make until a mail provider exists (R8).
   */
  @PostMapping("/password/reset-request")
  public ResponseEntity<ResetRequestResponse> requestReset(
      @Valid @RequestBody ResetRequestRequest request, HttpServletRequest http) {
    return ResponseEntity.accepted().body(service.requestPasswordReset(request, http));
  }

  @PostMapping("/password/reset")
  public ResponseEntity<Void> reset(
      @Valid @RequestBody ResetPasswordRequest request, HttpServletRequest http, HttpServletResponse response) {
    service.resetPassword(request, http);
    // Whatever the caller's session state was, the credential behind it has changed.
    clearRefreshCookie(response);
    return ResponseEntity.noContent().build();
  }

  @PostMapping("/password/change")
  public ResponseEntity<Void> changePassword(
      @Valid @RequestBody ChangePasswordRequest request, HttpServletRequest http, HttpServletResponse response) {
    service.changePassword(RequestContextHolder.require().userId(), request, http);
    clearRefreshCookie(response);
    return ResponseEntity.noContent().build();
  }

  /* ------------------------------------------------------------------ cookies */

  private void writeRefreshCookie(HttpServletResponse response, String token, Instant accessExpiresAt) {
    ResponseCookie cookie = ResponseCookie.from(properties.refresh().cookieName(), token)
        .httpOnly(true)
        .secure(properties.refresh().secure())
        .sameSite(properties.refresh().sameSite())
        // Scoping the cookie to /api/v1/auth means it is not sent with any other
        // request this origin serves, which limits the blast radius of a
        // misconfigured reverse proxy or an SSRF against another route.
        .path(properties.refresh().cookiePath())
        .maxAge(properties.refresh().ttlDays() * 86_400L)
        .build();
    response.addHeader(HttpHeaders.SET_COOKIE, cookie.toString());
  }

  private void clearRefreshCookie(HttpServletResponse response) {
    ResponseCookie cookie = ResponseCookie.from(properties.refresh().cookieName(), "")
        .httpOnly(true)
        .secure(properties.refresh().secure())
        .sameSite(properties.refresh().sameSite())
        .path(properties.refresh().cookiePath())
        .maxAge(0)
        .build();
    response.addHeader(HttpHeaders.SET_COOKIE, cookie.toString());
  }

  private String readRefreshCookie(HttpServletRequest request) {
    Cookie[] cookies = request.getCookies();
    if (cookies == null) return null;
    String name = properties.refresh().cookieName();
    for (Cookie cookie : cookies) {
      if (name.equals(cookie.getName())) return cookie.getValue();
    }
    return null;
  }
}
