package in.bissaathi.config;

import in.bissaathi.auth.TokenHasher;
import in.bissaathi.common.ApiException;
import in.bissaathi.common.AppProperties;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Double-submit CSRF protection for the cookie-borne auth routes (§8).
 *
 * The access token lives in memory and is sent as a header, so those routes are not
 * forgeable cross-site. The refresh token is a cookie and the browser will attach it
 * to a cross-site POST, so /auth/refresh and /auth/logout additionally require the
 * XSRF-TOKEN cookie value to be echoed in a header. Comparison is constant-time.
 *
 * The cookie is deliberately readable by script — that is what double-submit means.
 * Reading it is not an attack on its own: without the HttpOnly refresh cookie it
 * authorises nothing.
 */
public class CsrfFilter extends OncePerRequestFilter {

  private final AppProperties properties;

  public CsrfFilter(AppProperties properties) {
    this.properties = properties;
  }

  @Override
  protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
      throws ServletException, IOException {
    if (properties.csrf().enabled() && requiresProtection(request)) {
      String cookieValue = readCookie(request, properties.csrf().cookieName());
      String headerValue = request.getHeader(properties.csrf().headerName());
      if (cookieValue == null || headerValue == null || !TokenHasher.equals(cookieValue, headerValue)) {
        throw ApiException.forbiddenCsrf();
      }
    }
    chain.doFilter(request, response);
    // Issue or rotate the token after a successful login/logout, so a session never
    // reuses the token that was live while its identity was different.
    if (properties.csrf().enabled() && isAuthStateChange(request) && !response.isCommitted()) {
      addTokenCookie(response);
    }
  }

  private boolean requiresProtection(HttpServletRequest request) {
    String method = request.getMethod();
    if (method.equalsIgnoreCase("GET") || method.equalsIgnoreCase("HEAD") || method.equalsIgnoreCase("OPTIONS")) {
      return false;
    }
    String path = request.getRequestURI();
    // Only the cookie-borne routes: a bearer-authenticated POST carries no ambient
    // credential, so a CSRF token there would be ceremony.
    return path.startsWith("/api/v1/auth/");
  }

  private boolean isAuthStateChange(HttpServletRequest request) {
    String path = request.getRequestURI();
    return path.equals("/api/v1/auth/login")
        || path.equals("/api/v1/auth/register")
        || path.equals("/api/v1/auth/refresh")
        || path.equals("/api/v1/auth/logout");
  }

  private void addTokenCookie(HttpServletResponse response) {
    Cookie cookie = new Cookie(properties.csrf().cookieName(), TokenHasher.newResetToken());
    cookie.setPath("/");
    cookie.setHttpOnly(false);
    cookie.setSecure(properties.refresh().secure());
    response.addCookie(cookie);
  }

  private static String readCookie(HttpServletRequest request, String name) {
    Cookie[] cookies = request.getCookies();
    if (cookies == null) return null;
    for (Cookie cookie : cookies) {
      if (name.equals(cookie.getName())) return cookie.getValue();
    }
    return null;
  }
}
