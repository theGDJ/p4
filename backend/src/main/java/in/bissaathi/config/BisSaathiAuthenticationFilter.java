package in.bissaathi.config;

import in.bissaathi.auth.JwtService;
import in.bissaathi.audit.AuditService;
import in.bissaathi.common.ApiException;
import in.bissaathi.common.Role;
import in.bissaathi.domain.UserEntity;
import in.bissaathi.auth.AuthService;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.Set;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Resolves the caller from the bearer token and puts a {@link RequestContext} on the
 * thread.
 *
 * The important detail is what happens after the token is decoded: the user is
 * re-loaded from the database and the roles used for authorization come from that
 * row, not from the token's `roles` claim. A claim is a snapshot of who the caller
 * was 15 minutes ago, and §4 requires that a revoked role take effect immediately.
 * A deactivated or locked account is treated as unauthenticated.
 */
public class BisSaathiAuthenticationFilter extends OncePerRequestFilter {

  private final JwtService jwt;
  private final AuthService auth;
  private final AuditService audit;

  public BisSaathiAuthenticationFilter(JwtService jwt, AuthService auth, AuditService audit) {
    this.jwt = jwt;
    this.auth = auth;
    this.audit = audit;
  }

  @Override
  protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
      throws ServletException, IOException {
    String header = request.getHeader("Authorization");
    if (header == null || !header.regionMatches(true, 0, "Bearer ", 0, 7)) {
      RequestContextHolder.set(RequestContext.ANONYMOUS);
      try {
        chain.doFilter(request, response);
      } finally {
        RequestContextHolder.clear();
      }
      return;
    }

    String token = header.substring(7).trim();
    try {
      JwtService.DecodedToken decoded = jwt.decode(token);
      UserEntity user = auth.loadForAuthorization(decoded.userId());
      Set<Role> roles = user.roles();
      RequestContextHolder.set(RequestContext.of(user.getId(), roles));
      chain.doFilter(request, response);
    } catch (ApiException e) {
      // An invalid or expired token is not an error worth auditing per request — it
      // would let a bad actor generate unbounded audit volume. It is a clean 401.
      RequestContextHolder.set(RequestContext.ANONYMOUS);
      response.setStatus(e.code().status().value());
      response.setContentType("application/json;charset=UTF-8");
      response.getWriter()
          .write(
              "{\"error\":{\"code\":\"" + e.code().name() + "\",\"message\":\"" + escape(e.getMessage()) + "\",\"details\":[]}}");
    } finally {
      RequestContextHolder.clear();
    }
  }

  private static String escape(String value) {
    return value == null ? "" : value.replace("\\", "\\\\").replace("\"", "\\\"");
  }
}
