package in.bissaathi.config;

import in.bissaathi.common.Role;
import java.util.Set;
import java.util.UUID;

/**
 * The authenticated caller for the current request.
 *
 * A deliberate seam between modules: the auth filter populates it and every other
 * module reads it, so chat, admin and audit never have to know how a token was
 * parsed or where the user came from (§3, interfaces only between modules).
 */
public record RequestContext(UUID userId, Set<Role> roles, boolean authenticated) {

  public static final RequestContext ANONYMOUS = new RequestContext(null, Set.of(), false);

  public static RequestContext of(UUID userId, Set<Role> roles) {
    return new RequestContext(userId, roles, true);
  }

  public boolean has(Role required) {
    if (!authenticated) return false;
    for (Role held : roles) {
      if (held.implies(required)) return true;
    }
    return false;
  }
}
