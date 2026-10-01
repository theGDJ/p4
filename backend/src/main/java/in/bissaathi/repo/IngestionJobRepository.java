package in.bissaathi.repo;

import in.bissaathi.domain.IngestionJobEntity;
import java.util.List;
import java.util.UUID;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;

public interface IngestionJobRepository extends JpaRepository<IngestionJobEntity, UUID> {

  List<IngestionJobEntity> findByStateOrderByCreatedAtDesc(String state, Pageable pageable);

  long countByState(String state);
}
