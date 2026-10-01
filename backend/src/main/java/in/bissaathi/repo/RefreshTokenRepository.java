package in.bissaathi.repo;

import in.bissaathi.domain.RefreshTokenEntity;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface RefreshTokenRepository extends JpaRepository<RefreshTokenEntity, UUID> {

  Optional<RefreshTokenEntity> findByTokenHash(String tokenHash);

  List<RefreshTokenEntity> findByFamilyId(UUID familyId);

  List<RefreshTokenEntity> findByUserIdAndRevokedAtIsNull(UUID userId);

  /** Revokes a whole family — the response to reuse detection (§8). */
  @Modifying
  @Query("update RefreshTokenEntity t set t.revokedAt = :now where t.familyId = :familyId and t.revokedAt is null")
  int revokeFamily(@Param("familyId") UUID familyId, @Param("now") Instant now);

  /** Revokes every live token for a user — used on password change or reset. */
  @Modifying
  @Query("update RefreshTokenEntity t set t.revokedAt = :now where t.userId = :userId and t.revokedAt is null")
  int revokeAllForUser(@Param("userId") UUID userId, @Param("now") Instant now);

  /** Housekeeping: expired tokens carry no evidence value once the family is dead. */
  @Modifying
  @Query("delete from RefreshTokenEntity t where t.expiresAt < :cutoff and t.revokedAt is not null")
  int deleteExpiredAndRevokedBefore(@Param("cutoff") Instant cutoff);
}
