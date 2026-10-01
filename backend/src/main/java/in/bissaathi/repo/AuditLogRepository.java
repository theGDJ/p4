package in.bissaathi.repo;

import in.bissaathi.domain.AuditLogEntity;
import java.util.List;
import java.util.UUID;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;

/** Read access is gated at the controller (ADMIN only); the repository stays dumb. */
public interface AuditLogRepository extends JpaRepository<AuditLogEntity, UUID> {

  List<AuditLogEntity> findAllByOrderByCreatedAtDesc(Pageable pageable);

  List<AuditLogEntity> findByActorUserIdOrderByCreatedAtDesc(UUID actorUserId, Pageable pageable);

  long countByOutcome(String outcome);
}
