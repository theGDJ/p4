package in.bissaathi.common;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Set;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * §4 role matrix, unit-tested because it is the rule every endpoint depends on.
 *
 * These pass without a database, which is the point: if a container runtime is
 * missing, the hierarchy is still checked (R8 — a skipped suite must be visible).
 */
class RoleHierarchyTest {

  @Test
  @DisplayName("ADMIN implies CONTENT_MANAGER and USER")
  void adminImpliesLowerRoles() {
    assertThat(Role.ADMIN.implies(Role.CONTENT_MANAGER)).isTrue();
    assertThat(Role.ADMIN.implies(Role.USER)).isTrue();
    assertThat(Role.ADMIN.implies()).containsExactlyInAnyOrder(Role.ADMIN, Role.CONTENT_MANAGER, Role.USER);
  }

  @Test
  @DisplayName("CONTENT_MANAGER does not imply ADMIN")
  void contentManagerIsNotAdmin() {
    assertThat(Role.CONTENT_MANAGER.implies(Role.USER)).isTrue();
    assertThat(Role.CONTENT_MANAGER.implies(Role.ADMIN)).isFalse();
  }

  @Test
  @DisplayName("USER implies nothing above itself")
  void userImpliesOnlyItself() {
    assertThat(Role.USER.implies(Role.USER)).isTrue();
    assertThat(Role.USER.implies(Role.CONTENT_MANAGER)).isFalse();
    assertThat(Role.USER.implies(Role.ADMIN)).isFalse();
  }

  @Test
  @DisplayName("RequestContext.has() reads the effective set, not the literal one")
  void contextHonoursHierarchy() {
    RequestContext asAdmin = RequestContext.of(java.util.UUID.randomUUID(), Set.of(Role.ADMIN));
    RequestContext asManager = RequestContext.of(java.util.UUID.randomUUID(), Set.of(Role.CONTENT_MANAGER));
    RequestContext asUser = RequestContext.of(java.util.UUID.randomUUID(), Set.of(Role.USER));

    assertThat(asAdmin.has(Role.CONTENT_MANAGER)).isTrue();
    assertThat(asManager.has(Role.ADMIN)).isFalse();
    assertThat(asUser.has(Role.ADMIN)).isFalse();
    assertThat(asUser.has(Role.USER)).isTrue();
  }

  @Test
  @DisplayName("an anonymous context fails every check")
  void anonymousFailsClosed() {
    RequestContext anonymous = RequestContext.ANONYMOUS;
    assertThat(anonymous.has(Role.USER)).isFalse();
    assertThat(anonymous.has(Role.ADMIN)).isFalse();
    assertThat(anonymous.authenticated()).isFalse();
  }

  @Test
  @DisplayName("ErrorCode maps each code to exactly one status")
  void errorCodesHaveStableStatuses() {
    assertThat(ErrorCode.UNAUTHENTICATED.status().value()).isEqualTo(401);
    assertThat(ErrorCode.CSRF_FAILED.status().value()).isEqualTo(403);
    // IDOR answers 404, not 403: see ConversationService.
    assertThat(ErrorCode.NOT_FOUND.status().value()).isEqualTo(404);
    assertThat(ErrorCode.ACCOUNT_LOCKED.status().value()).isEqualTo(423);
    assertThat(ErrorCode.PROVIDER_UNAVAILABLE.status().value()).isEqualTo(503);
    // 422 OUT_OF_SCOPE is reserved for P2 and must not be wired to anything yet.
    assertThat(java.util.Arrays.stream(ErrorCode.values()).noneMatch(c -> c.status().value() == 422))
        .isTrue();
  }
}
