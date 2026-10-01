package in.bissaathi.common;

import java.util.Set;

/**
 * Authorization roles (§4).
 *
 * The hierarchy is ADMIN implies CONTENT_MANAGER implies USER, enforced server-side
 * on every endpoint. A frontend route guard hiding a link is cosmetic and is never
 * the control.
 */
public enum Role {
  USER,
  CONTENT_MANAGER,
  ADMIN;

  private static final Set<Role> ADMIN_IMPLIES = Set.of(ADMIN, CONTENT_MANAGER, USER);
  private static final Set<Role> CONTENT_MANAGER_IMPLIES = Set.of(CONTENT_MANAGER, USER);
  private static final Set<Role> USER_IMPLIES = Set.of(USER);

  /** Roles this role also satisfies. */
  public Set<Role> implies() {
    return switch (this) {
      case ADMIN -> ADMIN_IMPLIES;
      case CONTENT_MANAGER -> CONTENT_MANAGER_IMPLIES;
      case USER -> USER_IMPLIES;
    };
  }

  public boolean implies(Role required) {
    return implies().contains(required);
  }

  /** Spring Security authority name. */
  public String authority() {
    return "ROLE_" + name();
  }
}
