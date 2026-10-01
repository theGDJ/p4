package in.bissaathi.config;

import in.bissaathi.audit.AuditService;
import in.bissaathi.common.ApiException;
import in.bissaathi.common.Role;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.stereotype.Component;

/**
 * The server-side role check (§4).
 *
 * Every admin endpoint calls {@link #require} explicitly instead of relying only on a
 * security matcher, so a route added later without a matcher cannot default to open.
 * Denials are audited at the point of denial, which is where the evidence is.
 */
@Component
public class AuthorizationManager {

  private final AuditService audit;

  public AuthorizationManager(AuditService audit) {
    this.audit = audit;
  }

  /** Throws 401 when anonymous, 403 when authenticated without the role. */
  public RequestContext require(Role required, HttpServletRequest request) {
    RequestContext context = RequestContextHolder.peek();
    if (!context.authenticated()) {
      throw ApiException.unauthenticated("Authentication required.");
    }
    if (!context.has(required)) {
      audit.record(
          context.userId(),
          "authz.denied",
          "endpoint",
          request == null ? null : request.getRequestURI(),
          AuditService.DENIED,
          request,
          "{\"requiredRole\":\"" + required.name() + "\"}");
      throw ApiException.forbidden("You do not have access to this resource.");
    }
    return context;
  }

  public RequestContext requireUser(HttpServletRequest request) {
    RequestContext context = RequestContextHolder.peek();
    if (!context.authenticated()) {
      throw ApiException.unauthenticated("Authentication required.");
    }
    return context;
  }
}
