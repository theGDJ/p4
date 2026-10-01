package in.bissaathi.user;

import in.bissaathi.auth.dto.AuthDtos.MeResponse;
import in.bissaathi.auth.dto.AuthDtos.PatchMeRequest;
import in.bissaathi.config.AuthorizationManager;
import in.bissaathi.config.RequestContext;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.transaction.annotation.Transactional;

/**
 * The caller's own account (docs/API.md, "user").
 *
 * There is deliberately no /users/{id} route. An account is only ever addressable as
 * "me", resolved from the token, so there is no identifier in the request for a
 * caller to substitute and no authorization check that can be forgotten (R9).
 */
@RestController
@RequestMapping("/api/v1/users")
public class UserController {

  private final UserService service;
  private final AuthorizationManager authorization;

  public UserController(UserService service, AuthorizationManager authorization) {
    this.service = service;
    this.authorization = authorization;
  }

  @GetMapping("/me")
  @Transactional(readOnly = true)
  public MeResponse me(HttpServletRequest http) {
    RequestContext context = authorization.requireUser(http);
    return service.me(context.userId());
  }

  /**
   * The writable surface is exactly three fields. Roles, emailVerified and email are
   * absent from the DTO and an unknown key is rejected by the mapper, so
   * `{"roles":["ADMIN"]}` is a 400 rather than a silent no-op or, worse, a
   * promotion (§8 privilege escalation).
   */
  @PatchMapping("/me")
  @Transactional
  public MeResponse patch(@Valid @RequestBody PatchMeRequest request, HttpServletRequest http) {
    RequestContext context = authorization.requireUser(http);
    return service.patch(context.userId(), request);
  }
}
