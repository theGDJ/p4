package in.bissaathi.chat;

import in.bissaathi.chat.dto.ChatDtos.Conversation;
import in.bissaathi.chat.dto.ChatDtos.ConversationList;
import in.bissaathi.chat.dto.ChatDtos.CreateConversationRequest;
import in.bissaathi.chat.dto.ChatDtos.MessageList;
import in.bissaathi.chat.dto.ChatDtos.RenameConversationRequest;
import in.bissaathi.chat.dto.ChatDtos.SendMessageRequest;
import in.bissaathi.common.ApiException;
import in.bissaathi.config.AuthorizationManager;
import in.bissaathi.config.RequestContext;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.Valid;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Conversation CRUD and the SSE message endpoint.
 *
 * The caller's id comes from the request context and nowhere else — no endpoint
 * accepts a userId in a path or body, so there is no parameter for a client to
 * substitute (R9).
 */
@RestController
@RequestMapping("/api/v1/conversations")
public class ChatController {

  private static final int MAX_PAGE_SIZE = 100;
  private static final int MAX_TITLE_LENGTH = 160;

  private final ConversationService service;
  private final MessageStreamService streamService;
  private final AuthorizationManager authorization;

  public ChatController(ConversationService service, MessageStreamService streamService, AuthorizationManager authorization) {
    this.service = service;
    this.streamService = streamService;
    this.authorization = authorization;
  }

  @GetMapping
  public ConversationList list(
      @RequestParam(defaultValue = "20") int limit,
      @RequestParam(defaultValue = "0") int offset,
      HttpServletRequest http) {
    RequestContext context = authorization.requireUser(http);
    int bounded = Math.max(1, Math.min(limit, MAX_PAGE_SIZE));
    return service.list(context.userId(), bounded, Math.max(0, offset));
  }

  @PostMapping
  public ResponseEntity<Conversation> create(
      @RequestBody(required = false) CreateConversationRequest request, HttpServletRequest http) {
    RequestContext context = authorization.requireUser(http);
    String title = request == null ? null : request.title();
    if (title != null && title.length() > MAX_TITLE_LENGTH) {
      throw ApiException.validation(
          "Please check the highlighted fields.",
          java.util.List.of(new ApiException.FieldIssue("title", "Conversation title must be 160 characters or fewer.")));
    }
    Conversation created = service.create(context.userId(), title, null);
    return ResponseEntity.status(HttpStatus.CREATED).body(created);
  }

  @GetMapping("/{id}")
  public Conversation get(@PathVariable UUID id, HttpServletRequest http) {
    RequestContext context = authorization.requireUser(http);
    return service.get(context.userId(), id);
  }

  @PatchMapping("/{id}")
  public Conversation rename(@PathVariable UUID id, @Valid @RequestBody RenameConversationRequest request, HttpServletRequest http) {
    RequestContext context = authorization.requireUser(http);
    return service.rename(context.userId(), id, request.title());
  }

  @DeleteMapping("/{id}")
  public ResponseEntity<Void> delete(@PathVariable UUID id, HttpServletRequest http) {
    RequestContext context = authorization.requireUser(http);
    service.delete(context.userId(), id);
    return ResponseEntity.noContent().build();
  }

  @GetMapping("/{id}/messages")
  public MessageList messages(@PathVariable UUID id, HttpServletRequest http) {
    RequestContext context = authorization.requireUser(http);
    return service.messages(context.userId(), id);
  }

  /**
   * The answer stream.
   *
   * Written directly to the response rather than through a reactive type: the servlet
   * stack plus a flushing writer is the boring, debuggable version of this, and it
   * keeps the frame ordering visible in one place. Errors after the first byte has
   * been flushed must be an SSE `error` frame, because the status line is already sent
   * — which is exactly why ApiException is caught and re-framed here instead of being
   * allowed to reach the GlobalExceptionHandler.
   */
  @PostMapping(value = "/{id}/messages", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
  public void stream(
      @PathVariable UUID id, @Valid @RequestBody SendMessageRequest request, HttpServletRequest http, HttpServletResponse response)
      throws java.io.IOException {
    RequestContext context = authorization.requireUser(http);
    if (request.content() == null || request.content().isBlank() || request.content().length() > 4000) {
      throw ApiException.validation(
          "Please check the highlighted fields.",
          java.util.List.of(new ApiException.FieldIssue("content", "Message must be 1–4000 characters.")));
    }
    try {
      streamService.stream(context, id, request, response);
    } catch (ApiException e) {
      if (response.isCommitted()) {
        // Too late for a status code. Close the stream and let the client's reader
        // end; the audit record already exists.
        response.flushBuffer();
        return;
      }
      // Not yet committed: a normal JSON error body is correct and the handler will
      // shape it.
      throw e;
    }
  }
}
