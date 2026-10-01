package in.bissaathi.repo;

import in.bissaathi.domain.UserEntity;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface UserRepository extends JpaRepository<UserEntity, UUID> {

  /** Emails are stored lowercased, so lookups normalise first. */
  @Query("select u from UserEntity u where lower(u.email) = lower(:email)")
  Optional<UserEntity> findByEmailIgnoreCase(@Param("email") String email);

  boolean existsByEmailIgnoreCase(String email);

  @Query("select count(u) from UserEntity u where u.lockedUntil is not null and u.lockedUntil > CURRENT_TIMESTAMP")
  long countCurrentlyLocked();
}
