package in.bissaathi.repo;

import in.bissaathi.domain.MessageEntity;
import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

/** R9: userId is part of every query, not a post-filter. */
public interface MessageRepository extends JpaRepository<MessageEntity, UUID> {

  @Query(
      "select m from MessageEntity m where m.conversationId = :conversationId and m.userId = :userId "
          + "order by m.createdAt asc")
  List<MessageEntity> findByConversationAndUser(
      @Param("conversationId") UUID conversationId, @Param("userId") UUID userId);

  @Query("select count(m) from MessageEntity m where m.userId = :userId")
  long countForUser(@Param("userId") UUID userId);

  /**
   * Recent turns used as model context. Scoped by user as well as conversation so a
   * stolen conversation id cannot be used to read another account's history.
   */
  @Query(
      "select m from MessageEntity m where m.conversationId = :conversationId and m.userId = :userId "
          + "and m.error is null order by m.createdAt desc")
  List<MessageEntity> findRecentForContext(
      @Param("conversationId") UUID conversationId,
      @Param("userId") UUID userId,
      org.springframework.data.domain.Pageable pageable);
}
