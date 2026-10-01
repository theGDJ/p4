package in.bissaathi.user;

import in.bissaathi.audit.AuditService;
import in.bissaathi.auth.dto.AuthDtos.MeResponse;
import in.bissaathi.auth.dto.AuthDtos.PatchMeRequest;
import in.bissaathi.common.ApiException;
import in.bissaathi.domain.UserEntity;
import in.bissaathi.repo.ConversationRepository;
import in.bissaathi.repo.UserRepository;
import jakarta.servlet.http.HttpServletRequest;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Profile reads and the narrow, self-service write surface. */
@Service
public class UserService {

  private static final int FULL_NAME_MAX = 120;

  private final UserRepository users;
  private final ConversationRepository conversations;
  private final AuditService audit;

  public UserService(UserRepository users, ConversationRepository conversations, AuditService audit) {
    this.users = users;
    this.conversations = conversations;
    this.audit = audit;
  }

  @Transactional(readOnly = true)
  public MeResponse me(UUID userId) {
    UserEntity user = load(userId);
    return MeResponse.of(user, conversations.countForUser(user.getId()));
  }

  @Transactional
  public MeResponse patch(UUID userId, PatchMeRequest request) {
    UserEntity user = load(userId);

    if (request.fullName() != null) {
      // Control characters stripped rather than rejected: a stray zero-width space
      // from a paste is not worth failing a save over, and leaving it in place lets a
      // name render as something it is not.
      String cleaned = request.fullName().replaceAll("\\p{Cntrl}", "").trim();
      if (cleaned.isEmpty() || cleaned.length() > FULL_NAME_MAX) {
        throw ApiException.validation(
            "Please check the highlighted fields.",
            List.of(new ApiException.FieldIssue("fullName", "Full name must be 1–120 characters.")));
      }
      user.setFullName(cleaned);
    }
    if (request.persona() != null) user.setPersona(request.persona());
    if (request.language() != null) user.setLanguage(request.language());

    users.save(user);
    audit.recordFor(user, "user.profile.updated", "user", user.getId().toString(), AuditService.SUCCESS, null, null);
    return MeResponse.of(user, conversations.countForUser(user.getId()));
  }

  /** Also used by the auth module to re-read roles on every request. */
  @Transactional(readOnly = true)
  public UserEntity load(UUID userId) {
    return users.findById(userId).orElseThrow(() -> ApiException.unauthenticated("Authentication required."));
  }
}
