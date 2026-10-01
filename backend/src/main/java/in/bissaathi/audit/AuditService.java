package in.bissaathi.audit;

import in.bissaathi.common.TraceFilter;
import in.bissaathi.domain.AuditLogEntity;
import in.bissaathi.domain.UserEntity;
import in.bissaathi.repo.AuditLogRepository;
import jakarta.servlet.http.HttpServletRequest;
import java.util.Set;
import java.util.stream.Collectors;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/**
 * The audit trail (§8, feature #15).
 *
 * Two deliberate choices:
 *  - REQUIRES_NEW, so a denial that rolls back the caller's transaction is still
 *    recorded. Losing the record of a denied access is worse than losing the
 *    transaction that caused it.
 *  - Audit failures are logged and swallowed. An audit write must never turn a
 *    successful, already-committed user action into a 500.
 *
 * No PII beyond the actor id, IP and user agent is stored. Emails are never written
 * to the audit log; the actor is identified by an opaque id that can be joined when
 * an ADMIN legitimately needs it.
 */
@Service
public class AuditService {

  public static final String SUCCESS = AuditLogEntity.SUCCESS;
  public static final String DENIED = AuditLogEntity.DENIED;
  public static final String FAILURE = AuditLogEntity.FAILURE;

  private static final Logger log = LoggerFactory.getLogger(AuditService.class);

  private final AuditLogRepository repository;

  public AuditService(AuditLogRepository repository) {
    this.repository = repository;
  }

  @Transactional(propagation = Propagation.REQUIRES_NEW)
  public void record(
      java.util.UUID actorUserId,
      String action,
      String entityType,
      String entityId,
      String outcome,
      HttpServletRequest request,
      String metadataJson) {
    try {
      repository.save(
          new AuditLogEntity(
              actorUserId,
              "[]",
              action,
              entityType,
              entityId,
              outcome,
              request == null ? null : request.getRemoteAddr(),
              truncate(request == null ? null : request.getHeader("User-Agent"), 512),
              TraceFilter.current(),
              metadataJson));
    } catch (RuntimeException e) {
      // R8: the failure is reported in the log with the trace ref so it is
      // discoverable, but it must not corrupt the request that caused it.
      log.error("audit write failed action={} outcome={} trace={}", action, outcome, TraceFilter.current(), e);
    }
  }

  /** Convenience for actions performed by a known, loaded user. */
  @Transactional(propagation = Propagation.REQUIRES_NEW)
  public void recordFor(
      UserEntity actor,
      String action,
      String entityType,
      String entityId,
      String outcome,
      HttpServletRequest request,
      String metadataJson) {
    Set<String> roles = actor.roles().stream().map(Enum::name).sorted().collect(Collectors.toSet());
    try {
      repository.save(
          new AuditLogEntity(
              actor.getId(),
              toJsonArray(roles),
              action,
              entityType,
              entityId,
              outcome,
              request == null ? null : request.getRemoteAddr(),
              truncate(request == null ? null : request.getHeader("User-Agent"), 512),
              TraceFilter.current(),
              metadataJson));
    } catch (RuntimeException e) {
      log.error("audit write failed action={} outcome={} trace={}", action, outcome, TraceFilter.current(), e);
    }
  }

  private static String toJsonArray(Set<String> values) {
    if (values == null || values.isEmpty()) return "[]";
    return values.stream().map(v -> "\"" + v.replace("\"", "\\\"") + "\"").collect(Collectors.joining(",", "[", "]"));
  }

  private static String truncate(String value, int max) {
    if (value == null) return null;
    return value.length() <= max ? value : value.substring(0, max);
  }
}
