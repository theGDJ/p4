package in.bissaathi.chat.dto;

import in.bissaathi.common.EvidenceTier;
import in.bissaathi.common.Intent;
import in.bissaathi.common.Language;
import in.bissaathi.common.VerificationStatus;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.time.Instant;
import java.util.List;

/** Request and response shapes for conversations and messages (docs/API.md, "chat"). */
public final class ChatDtos {

  private ChatDtos() {}

  public record CreateConversationRequest(@Size(max = 160) String title) {}

  public record RenameConversationRequest(@NotNull @Size(min = 1, max = 160) String title) {}

  public record Conversation(
      java.util.UUID id, String title, String summary, Language language, Instant createdAt, Instant updatedAt) {}

  public record ConversationList(List<Conversation> items, long total) {}

  public record Source(
      String ref,
      String chunkId,
      String title,
      String standardNo,
      String section,
      String docType,
      Language language,
      String sourceUrl,
      VerificationStatus verificationStatus,
      Instant verifiedAt,
      String snippet) {}

  public record Message(
      java.util.UUID id,
      String role,
      String content,
      List<Source> sources,
      EvidenceTier evidenceTier,
      Intent intent,
      Language language,
      Instant createdAt,
      String error) {}

  public record MessageList(List<Message> items, long total) {}

  /** The body of POST /conversations/{id}/messages. The stream itself is not JSON. */
  public record SendMessageRequest(@NotNull @Size(min = 1, max = 4000) String content, Language language) {}
}
