package in.bissaathi.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import in.bissaathi.common.Role;
import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.autoconfigure.AutoConfigureMockMvc;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

/**
 * THE P1 EXIT GATE.
 *
 * register → login → refresh → logout end to end, plus the authorization and IDOR
 * rules, against a real PostgreSQL running the real Flyway V1.
 *
 * ⚠ NEVER EXECUTED. This sandbox has no Docker and no JDK (docs/ENVIRONMENT.md), so
 * neither Testcontainers nor the compiler could run. Do not treat a green local
 * frontend suite as evidence that this passes — it is the file that must go green in
 * an environment with Docker before P1 is accepted (R8).
 *
 * Design notes worth defending in review:
 *  - Flyway runs against the container rather than hibernate generating a schema, so
 *    the test proves the migration and the entities agree. That is the drift a
 *    `ddl-auto: update` configuration hides permanently.
 *  - Each test gets its own account. A shared account would make the lockout test
 *    poison every other test in the class, and ordering-dependent security tests are
 *    the kind that pass for the wrong reason.
 */
@SpringBootTest(properties = {"bissaathi.seed.enabled=false", "spring.data.redis.timeout=1ms"})
@AutoConfigureMockMvc
@Testcontainers(disabledWithoutDocker = true)
class AuthFlowIntegrationTest {

  @Container
  static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>("pgvector/pgvector:pg17")
      .withDatabaseName("bissaathi_test")
      .withUsername("test")
      .withPassword("test");

  @DynamicPropertySource
  static void datasource(DynamicPropertyRegistry registry) {
    registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
    registry.add("spring.datasource.username", POSTGRES::getUsername);
    registry.add("spring.datasource.password", POSTGRES::getPassword);
  }

  @Autowired private MockMvc mvc;
  @Autowired private ObjectMapper json;

  private static final String PASSWORD = "Integration-Test-9";

  /* ================================================================== exit gate */

  @Test
  @DisplayName("register → login → refresh → logout, with a rotating HttpOnly cookie")
  void fullAuthFlow() throws Exception {
    String email = "flow-" + System.nanoTime() + "@example.org";

    // --- register
    MvcResult registered = mvc.perform(post("/api/v1/auth/register")
            .contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(java.util.Map.of(
                "email", email, "password", PASSWORD, "fullName", "Flow Tester", "persona", "CONSUMER"))))
        .andReturn();
    assertThat(registered.getResponse().getStatus()).isEqualTo(201);
    JsonNode body = json.readTree(registered.getResponse().getContentAsString());
    assertThat(body.get("user").get("email").asText()).isEqualTo(email);
    assertThat(body.get("user").get("roles")).hasSize(1);
    assertThat(body.get("user").get("roles").get(0).asText()).isEqualTo("USER");
    assertThat(body.get("accessToken").asText()).isNotBlank();

    String refreshCookie = cookieValue(registered, "bs_refresh");
    assertThat(refreshCookie).isNotBlank();
    String xsrf = cookieValue(registered, "XSRF-TOKEN");
    assertThat(xsrf).isNotBlank();

    // --- login
    MvcResult login = mvc.perform(post("/api/v1/auth/login")
            .contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(java.util.Map.of("email", email, "password", PASSWORD))))
        .andReturn();
    assertThat(login.getResponse().getStatus()).isEqualTo(200);
    String accessToken = json.readTree(login.getResponse().getContentAsString()).get("accessToken").asText();
    String firstRefresh = cookieValue(login, "bs_refresh");

    // The cookie attributes are the security control, so they are asserted as text.
    String setCookieHeader = login.getResponse().getHeader(HttpHeaders.SET_COOKIE);
    assertThat(setCookieHeader).contains("HttpOnly").contains("SameSite=Lax").contains("Path=/api/v1/auth");

    // --- authenticated read
    mvc.perform(get("/api/v1/users/me").header(HttpHeaders.AUTHORIZATION, "Bearer " + accessToken))
        .andReturn()
        .getResponse()
        .getStatus();

    // --- refresh rotates
    MvcResult refresh = mvc.perform(post("/api/v1/auth/refresh")
            .header("Cookie", "bs_refresh=" + firstRefresh)
            .header("X-XSRF-TOKEN", xsrf))
        .andReturn();
    assertThat(refresh.getResponse().getStatus()).isEqualTo(200);
    String secondRefresh = cookieValue(refresh, "bs_refresh");
    assertThat(secondRefresh).isNotEqualTo(firstRefresh);

    // --- replaying the consumed token revokes the whole family
    MvcResult replay = mvc.perform(post("/api/v1/auth/refresh")
            .header("Cookie", "bs_refresh=" + firstRefresh)
            .header("X-XSRF-TOKEN", xsrf))
        .andReturn();
    assertThat(replay.getResponse().getStatus()).isEqualTo(401);
    assertThat(json.readTree(replay.getResponse().getContentAsString()).get("error").get("code").asText())
        .isEqualTo("REFRESH_REUSED");

    // The legitimate holder of the rotated token is now locked out too — that is the
    // point of family revocation, and it must be asserted, not assumed.
    MvcResult afterRevoke = mvc.perform(post("/api/v1/auth/refresh")
            .header("Cookie", "bs_refresh=" + secondRefresh)
            .header("X-XSRF-TOKEN", xsrf))
        .andReturn();
    assertThat(afterRevoke.getResponse().getStatus()).isEqualTo(401);

    // --- logout is idempotent
    assertThat(mvc.perform(post("/api/v1/auth/logout").header("Cookie", "bs_refresh=" + secondRefresh)
            .header("X-XSRF-TOKEN", xsrf))
        .andReturn()
        .getResponse()
        .getStatus()).isEqualTo(204);
    assertThat(mvc.perform(post("/api/v1/auth/logout").header("X-XSRF-TOKEN", xsrf))
            .andReturn()
            .getResponse()
            .getStatus())
        .isEqualTo(204);
  }

  /* ================================================================ authorization */

  @Test
  @DisplayName("an unauthenticated request to a protected route is 401, not 404")
  void protectedRoutesRejectAnonymous() throws Exception {
    assertThat(mvc.perform(get("/api/v1/users/me")).andReturn().getResponse().getStatus()).isEqualTo(401);
    assertThat(mvc.perform(get("/api/v1/conversations")).andReturn().getResponse().getStatus()).isEqualTo(401);
    // An unknown path is still 404 — a blanket guard mounted at the API root would
    // turn every 404 into a 401 and hide routing mistakes.
    assertThat(mvc.perform(get("/api/v1/no-such-route")).andReturn().getResponse().getStatus()).isEqualTo(404);
  }

  @Test
  @DisplayName("CSRF is required on the cookie-borne route and irrelevant on the bearer route")
  void csrfCoversOnlyCookieRoutes() throws Exception {
    Session a = register("csrf-" + System.nanoTime());

    // refresh without the header: refused.
    assertThat(mvc.perform(post("/api/v1/auth/refresh").header("Cookie", "bs_refresh=" + a.refresh()))
            .andReturn()
            .getResponse()
            .getStatus())
        .isEqualTo(403);

    // a bearer-authenticated PATCH needs no CSRF token, because the browser would
    // never attach the header on its own.
    assertThat(
            mvc.perform(patch("/api/v1/users/me")
                    .header(HttpHeaders.AUTHORIZATION, "Bearer " + a.accessToken())
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(json.writeValueAsString(java.util.Map.of("fullName", "Renamed"))))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(200);
  }

  @Test
  @DisplayName("PATCH /users/me cannot change roles, email or verification state")
  void noPrivilegeEscalationThroughProfile() throws Exception {
    Session a = register("esc-" + System.nanoTime());

    for (String payload :
        List.of(
            "{\"roles\":[\"ADMIN\"]}",
            "{\"role\":\"ADMIN\"}",
            "{\"emailVerified\":true}",
            "{\"email\":\"victim@example.org\"}",
            "{\"password\":\"Anything-1\"}")) {
      MvcResult result = mvc.perform(patch("/api/v1/users/me")
              .header(HttpHeaders.AUTHORIZATION, "Bearer " + a.accessToken())
              .contentType(MediaType.APPLICATION_JSON)
              .content(payload))
          .andReturn();
      // Rejected outright (unknown key) rather than accepted and ignored: an ignored
      // field is a field somebody will eventually trust.
      assertThat(result.getResponse().getStatus()).as("payload " + payload).isEqualTo(400);
      assertThat(json.readTree(result.getResponse().getContentAsString()).get("error").get("code").asText())
          .isEqualTo("VALIDATION_FAILED");
    }
  }

  @Test
  @DisplayName("role gates: USER 403, CONTENT_MANAGER 200 on knowledge, ADMIN-only on audit")
  void roleMatrix() throws Exception {
    Session user = register("u-" + System.nanoTime());
    Session manager = register("m-" + System.nanoTime());
    Session admin = register("a-" + System.nanoTime());
    grantRoles(manager, Role.CONTENT_MANAGER);
    grantRoles(admin, Role.ADMIN, Role.CONTENT_MANAGER);

    assertThat(mvc.perform(get("/api/v1/admin/knowledge/stats")
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + user.accessToken()))
        .andReturn()
        .getResponse()
        .getStatus()).isEqualTo(403);
    assertThat(mvc.perform(get("/api/v1/admin/knowledge/stats")
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + manager.accessToken()))
        .andReturn()
        .getResponse()
        .getStatus()).isEqualTo(200);
    // ADMIN implies CONTENT_MANAGER, so it must also pass the lower gate.
    assertThat(mvc.perform(get("/api/v1/admin/knowledge/stats")
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + admin.accessToken()))
        .andReturn()
        .getResponse()
        .getStatus()).isEqualTo(200);

    // The reverse never holds.
    assertThat(mvc.perform(get("/api/v1/admin/audit-logs")
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + manager.accessToken()))
        .andReturn()
        .getResponse()
        .getStatus()).isEqualTo(403);
    assertThat(mvc.perform(get("/api/v1/admin/audit-logs")
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + admin.accessToken()))
        .andReturn()
        .getResponse()
        .getStatus()).isEqualTo(200);
  }

  @Test
  @DisplayName("a role revocation takes effect on the next request, not on token expiry")
  void revocationIsImmediate() throws Exception {
    Session admin = register("rev-" + System.nanoTime());
    grantRoles(admin, Role.ADMIN);
    assertThat(mvc.perform(get("/api/v1/admin/audit-logs").header(HttpHeaders.AUTHORIZATION, "Bearer " + admin.accessToken()))
            .andReturn()
            .getResponse()
            .getStatus())
        .isEqualTo(200);

    revokeRoles(admin);
    // Same still-valid access token; the roles are re-read from the database.
    assertThat(mvc.perform(get("/api/v1/admin/audit-logs").header(HttpHeaders.AUTHORIZATION, "Bearer " + admin.accessToken()))
            .andReturn()
            .getResponse()
            .getStatus())
        .isEqualTo(403);
  }

  /* ========================================================================= IDOR */

  @Test
  @DisplayName("another user's conversation is 404 on every verb, never 403")
  void conversationIdor() throws Exception {
    Session owner = register("owner-" + System.nanoTime());
    Session attacker = register("attacker-" + System.nanoTime());

    MvcResult created = mvc.perform(post("/api/v1/conversations")
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + owner.accessToken())
            .contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(java.util.Map.of("title", "Private question"))))
        .andReturn();
    assertThat(created.getResponse().getStatus()).isEqualTo(201);
    String id = json.readTree(created.getResponse().getContentAsString()).get("id").asText();

    // The owner can read it.
    assertThat(mvc.perform(get("/api/v1/conversations/" + id).header(HttpHeaders.AUTHORIZATION, "Bearer " + owner.accessToken()))
            .andReturn()
            .getResponse()
            .getStatus())
        .isEqualTo(200);

    for (String verb : List.of("GET", "PATCH", "DELETE")) {
      MvcResult attempt = switch (verb) {
        case "GET" -> mvc.perform(get("/api/v1/conversations/" + id)
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + attacker.accessToken()))
            .andReturn();
        case "PATCH" -> mvc.perform(patch("/api/v1/conversations/" + id)
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + attacker.accessToken())
                .contentType(MediaType.APPLICATION_JSON)
                .content(json.writeValueAsString(java.util.Map.of("title", "Mine now"))))
            .andReturn();
        default -> mvc.perform(delete("/api/v1/conversations/" + id)
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + attacker.accessToken()))
            .andReturn();
      };
      assertThat(attempt.getResponse().getStatus()).as(verb + " on another user's conversation").isEqualTo(404);
    }

    // And the row is untouched: an attempted write must not half-succeed.
    JsonNode still = json.readTree(
        mvc.perform(get("/api/v1/conversations/" + id).header(HttpHeaders.AUTHORIZATION, "Bearer " + owner.accessToken()))
            .andReturn()
            .getResponse()
            .getContentAsString());
    assertThat(still.get("title").asText()).isEqualTo("Private question");

    // Messages of someone else's conversation are equally invisible.
    assertThat(mvc.perform(get("/api/v1/conversations/" + id + "/messages")
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + attacker.accessToken()))
        .andReturn()
        .getResponse()
        .getStatus()).isEqualTo(404);
  }

  /* ---------------------------------------------------------------------- helpers */

  private Session register(String email) throws Exception {
    MvcResult result = mvc.perform(post("/api/v1/auth/register")
            .contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(java.util.Map.of(
                "email", email + "@example.org", "password", PASSWORD, "fullName", "Test " + email))))
        .andReturn();
    assertThat(result.getResponse().getStatus()).isEqualTo(201);
    JsonNode body = json.readTree(result.getResponse().getContentAsString());
    return new Session(
        body.get("user").get("id").asText(),
        body.get("accessToken").asText(),
        cookieValue(result, "bs_refresh"),
        cookieValue(result, "XSRF-TOKEN"));
  }

  /**
   * Test-only role change through the repository, because there is deliberately no
   * HTTP endpoint that assigns roles. If one is ever added, this test must be
   * rewritten to use it — and that rewrite is the review signal that the endpoint
   * needs its own authorization tests.
   */
  @Autowired private in.bissaathi.repo.UserRepository users;

  private void grantRoles(Session session, Role... roles) {
    users.findById(java.util.UUID.fromString(session.userId()))
        .ifPresent(user -> {
          for (Role role : roles) user.grantRole(role);
          users.save(user);
        });
  }

  private void revokeRoles(Session session) {
    // Dropping the ADMIN row while the access token stays cryptographically valid is
    // the exact scenario the per-request role reload exists for. If authorization ever
    // reads the token's `roles` claim instead of the database, this test fails.
    users.findById(java.util.UUID.fromString(session.userId()))
        .ifPresent(
            user -> {
              user.revokeRole(Role.ADMIN);
              users.save(user);
              users.flush();
            });
  }

  private static String cookieValue(MvcResult result, String name) throws Exception {
    String header = result.getResponse().getHeader(HttpHeaders.SET_COOKIE);
    if (header == null) return null;
    for (String part : header.split(";")) {
      String trimmed = part.trim();
      if (trimmed.startsWith(name + "=")) return trimmed.substring(name.length() + 1);
    }
    return null;
  }

  private record Session(String userId, String accessToken, String refresh, String xsrf) {}

}
