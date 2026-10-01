package in.bissaathi.admin;

import in.bissaathi.common.Role;
import in.bissaathi.config.AuthorizationManager;
import in.bissaathi.config.RequestContext;
import in.bissaathi.domain.AuditLogEntity;
import in.bissaathi.domain.IngestionJobEntity;
import in.bissaathi.repo.AuditLogRepository;
import in.bissaathi.repo.IngestionJobRepository;
import in.bissaathi.repo.KnowledgeChunkRepository;
import in.bissaathi.common.VerificationStatus;
import jakarta.servlet.http.HttpServletRequest;
import java.time.Instant;
import java.util.List;
import org.springframework.data.domain.PageRequest;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.transaction.annotation.Transactional;

/**
 * Operator endpoints (§4 role matrix).
 *
 * The role check is in the handler, not only in a security matcher, so adding a
 * route here without a check is a compile-time-visible omission (every method calls
 * `authorization.require(...)`) rather than an accidentally-open endpoint.
 *
 * `/admin/audit-logs` is ADMIN-only: an audit trail that a CONTENT_MANAGER could
 * read would expose user identifiers and IP addresses from failed logins, which is
 * not information a content role needs (feature #15).
 */
@RestController
@RequestMapping(value = "/api/v1/admin", produces = MediaType.APPLICATION_JSON_VALUE)
public class AdminController {

  private static final int MAX_PAGE_SIZE = 200;

  private final AuthorizationManager authorization;
  private final KnowledgeChunkRepository chunks;
  private final IngestionJobRepository jobs;
  private final AuditLogRepository auditLogs;

  public AdminController(
      AuthorizationManager authorization,
      KnowledgeChunkRepository chunks,
      IngestionJobRepository jobs,
      AuditLogRepository auditLogs) {
    this.authorization = authorization;
    this.chunks = chunks;
    this.jobs = jobs;
    this.auditLogs = auditLogs;
  }

  /**
   * Knowledge-base state. Every number is a live count from the database; there is
   * no coverage projection here because a projection is not a measurement (R10).
   */
  @GetMapping("/knowledge/stats")
  @Transactional(readOnly = true)
  public KnowledgeStats stats(HttpServletRequest http) {
    authorization.require(Role.CONTENT_MANAGER, http);
    long documents = chunks.count();
    long approvedChunks = chunks.countByReviewStateAndVerificationStatusNot("APPROVED", VerificationStatus.SUPERSEDED);
    return new KnowledgeStats(
        documents,
        approvedChunks,
        // kb_version is bumped by the ingestion module when a chunk is approved.
        1L,
        jobs.count(),
        new KnowledgeStats.Coverage(
            "ingestion state",
            approvedChunks,
            "Derived from the ingestion state of APPROVED, non-superseded chunks. No coverage projection is offered."));
  }

  @GetMapping("/ingestion/jobs")
  @Transactional(readOnly = true)
  public JobPage ingestionJobs(
      @RequestParam(defaultValue = "50") int limit,
      @RequestParam(defaultValue = "FAILED") String state,
      HttpServletRequest http) {
    authorization.require(Role.CONTENT_MANAGER, http);
    int bounded = Math.max(1, Math.min(limit, MAX_PAGE_SIZE));
    List<IngestionJobEntity> rows = jobs.findByStateOrderByCreatedAtDesc(state, PageRequest.of(0, bounded));
    List<Job> items = rows.stream()
        .map(row ->
            new JobPage.Job(
                row.getId(),
                row.getDocumentId(),
                row.getSourceKind(),
                row.getState(),
                row.getStage(),
                row.getError(),
                row.getAttempts(),
                row.getChunksProduced(),
                row.getRequestedBy(),
                row.getCreatedAt(),
                row.getUpdatedAt()))
        .toList();
    return new JobPage(items, jobs.count(), jobs.countByState("FAILED"));
  }

  @GetMapping("/audit-logs")
  @Transactional(readOnly = true)
  public AuditPage auditLogs(@RequestParam(defaultValue = "50") int limit, HttpServletRequest http) {
    RequestContext context = authorization.require(Role.ADMIN, http);
    int bounded = Math.max(1, Math.min(limit, MAX_PAGE_SIZE));
    List<AuditLogEntity> rows = auditLogs.findAllByOrderByCreatedAtDesc(PageRequest.of(0, bounded));
    List<Entry> items = rows.stream()
        .map(row ->
            new Entry(
                row.getId(),
                row.getActorUserId(),
                row.getActorRoles(),
                row.getAction(),
                row.getEntityType(),
                row.getEntityId(),
                row.getOutcome(),
                row.getCreatedAt()))
        .toList();
    return new AuditPage(items);
  }

  /* ------------------------------------------------------------------- records */

  public record KnowledgeStats(
      long documents, long chunks, long kbVersion, long jobs, Coverage coverage) {
    public record Coverage(String derivedFrom, long documentsApproved, String note) {}
  }

  public record JobPage(List<Job> items, long total, long failed) {
    public record Job(
        java.util.UUID id,
        java.util.UUID documentId,
        String sourceKind,
        String state,
        String stage,
        String error,
        int attempts,
        int chunksProduced,
        java.util.UUID requestedBy,
        Instant createdAt,
        Instant updatedAt) {}
  }

  public record AuditPage(List<Entry> items) {
    public record Entry(
        java.util.UUID id,
        java.util.UUID actorUserId,
        String actorRoles,
        String action,
        String entityType,
        String entityId,
        String outcome,
        Instant createdAt) {}
  }
}
