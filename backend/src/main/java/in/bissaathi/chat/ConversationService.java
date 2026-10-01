package in.bissaathi.chat;

import in.bissaathi.chat.dto.ChatDtos.Conversation;
import in.bissaathi.chat.dto.ChatDtos.ConversationList;
import in.bissaathi.chat.dto.ChatDtos.Message;
import in.bissaathi.chat.dto.ChatDtos.MessageList;
import in.bissaathi.chat.dto.ChatDtos.Source;
import in.bissaathi.common.ApiException;
import in.bissaathi.common.EvidenceTier;
import in.bissaathi.common.Intent;
import in.bissaathi.common.Language;
import in.bissaathi.domain.ConversationEntity;
import in.bissaathi.domain.MessageEntity;
import in.bissaathi.repo.ConversationRepository;
import in.bissaathi.repo.MessageRepository;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.List;
import java.util.UUID;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Conversation and message persistence, always scoped by user (R9).
 *
 * Every read and write below passes userId into the repository call. There is no
 * `findById(id)` for user data anywhere in this class, and the not-found answer for
 * "that belongs to somebody else" is the same 404 as "that does not exist" — a 403
 * would confirm that the id is real, which is an information leak through an
 * authorization check (see mock-api/tests/authz-idor.test.ts for the same rule).
 */
@Service
public class ConversationService {

  private final ConversationRepository conversations;
  private final MessageRepository messages;
  private final ObjectMapper objectMapper;

  public ConversationService(
      ConversationRepository conversations, MessageRepository messages, ObjectMapper objectMapper) {
    this.conversations = conversations;
    this.messages = messages;
    this.objectMapper = objectMapper;
  }

  @Transactional
  public Conversation create(UUID userId, String title, Language language) {
    ConversationEntity entity =
        new ConversationEntity(userId, title == null || title.isBlank() ? "New conversation" : title.trim(),
            language == null ? Language.en : language);
    conversations.save(entity);
    return toDto(entity);
  }

  @Transactional(readOnly = true)
  public ConversationList list(UUID userId, int limit, int offset) {
    List<Conversation> items =
        conversations.listForUser(userId, PageRequest.of(offset / Math.max(1, limit), Math.max(1, limit))).stream()
            .map(ConversationService::toDto)
            .toList();
    return new ConversationList(items, conversations.countForUser(userId));
  }

  @Transactional(readOnly = true)
  public Conversation get(UUID userId, UUID id) {
    return toDto(owned(userId, id));
  }

  @Transactional
  public Conversation rename(UUID userId, UUID id, String title) {
    ConversationEntity entity = owned(userId, id);
    entity.setTitle(title.trim());
    conversations.save(entity);
    return toDto(entity);
  }

  @Transactional
  public void delete(UUID userId, UUID id) {
    ConversationEntity entity = owned(userId, id);
    conversations.delete(entity);
  }

  @Transactional(readOnly = true)
  public MessageList messages(UUID userId, UUID conversationId) {
    owned(userId, conversationId);
    List<Message> items = messages.findByConversationAndUser(conversationId, userId).stream()
        .map(this::toDto)
        .toList();
    return new MessageList(items, items.size());
  }

  /** The loaded, owned conversation. Used by the message stream before it starts. */
  @Transactional(readOnly = true)
  public ConversationEntity owned(UUID userId, UUID conversationId) {
    return conversations.findByIdAndUserId(conversationId, userId).orElseThrow(ApiException::notFound);
  }

  @Transactional
  public MessageEntity persist(
      ConversationEntity conversation,
      String role,
      String content,
      List<Source> sources,
      EvidenceTier tier,
      Intent intent,
      Language language,
      List<String> followUps,
      Integer promptTokens,
      Integer completionTokens,
      String model,
      Integer retrievalMs,
      String error) {
    MessageEntity entity = new MessageEntity(conversation.getId(), conversation.getUserId(), role, content, language);
    entity.setIntent(intent);
    entity.setEvidenceTier(tier);
    entity.setSourcesJson(writeJson(sources));
    entity.setFollowUps(writeJson(followUps));
    entity.setUsage(
        promptTokens == null ? 0 : promptTokens, completionTokens == null ? 0 : completionTokens, model);
    entity.setRetrievalMs(retrievalMs);
    entity.setError(error);
    return messages.save(entity);
  }

  /** Bumps updated_at so the conversation moves to the top of the list. */
  @Transactional
  public void touch(UUID userId, UUID conversationId) {
    ConversationEntity entity = owned(userId, conversationId);
    conversations.save(entity);
  }

  public String writeJson(Object value) {
    try {
      return objectMapper.writeValueAsString(value == null ? List.of() : value);
    } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
      // A serialization failure here means the DTO is wrong, which is a bug in this
      // build, not a user error. Wrapping it keeps the cause for the log.
      throw new IllegalStateException("Unable to serialize JSON column", e);
    }
  }

  public List<Source> readSources(String json) {
    if (json == null || json.isBlank()) return List.of();
    try {
      return objectMapper.readValue(json, new TypeReference<List<Source>>() {});
    } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
      // Stored evidence that cannot be read back is a data-integrity failure. Say so
      // rather than silently returning an empty source list, which would look like
      // "this answer had no sources" (R8).
      throw new IllegalStateException("Stored sources_json is unreadable", e);
    }
  }

  private Message toDto(MessageEntity entity) {
    return new Message(
        entity.getId(),
        entity.getRole(),
        entity.getContent(),
        readSources(entity.getSourcesJson()),
        entity.getEvidenceTier(),
        entity.getIntent(),
        entity.getLanguage(),
        entity.getCreatedAt(),
        entity.getError());
  }

  private static Conversation toDto(ConversationEntity entity) {
    return new Conversation(
        entity.getId(),
        entity.getTitle(),
        entity.getSummary(),
        entity.getLanguage(),
        entity.getCreatedAt(),
        entity.getUpdatedAt());
  }

}
