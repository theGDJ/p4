package in.bissaathi.repo;

import in.bissaathi.domain.ConversationEntity;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

/**
 * R9 in repository form.
 *
 * Every finder takes userId as a parameter and puts it in the WHERE clause. There
 * is deliberately no `findById(UUID)` override that skips it: the inherited one
 * exists for JPA's sake, but no controller or service calls it for user data. A
 * conversation belonging to someone else is not "forbidden", it is "not found" —
 * answering 403 would confirm that the id exists.
 */
public interface ConversationRepository extends JpaRepository<ConversationEntity, UUID> {

  @Query(
      "select c from ConversationEntity c where c.userId = :userId and c.archivedAt is null "
          + "order by c.updatedAt desc")
  List<ConversationEntity> listForUser(@Param("userId") UUID userId, Pageable pageable);

  @Query("select c from ConversationEntity c where c.id = :id and c.userId = :userId")
  Optional<ConversationEntity> findByIdAndUserId(@Param("id") UUID id, @Param("userId") UUID userId);

  @Query("select count(c) from ConversationEntity c where c.userId = :userId")
  long countForUser(@Param("userId") UUID userId);

  @Query("delete from ConversationEntity c where c.id = :id and c.userId = :userId")
  void deleteByIdAndUserId(@Param("id") UUID id, @Param("userId") UUID userId);
}
