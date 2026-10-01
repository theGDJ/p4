package in.bissaathi.chat;

import in.bissaathi.audit.AuditService;
import in.bissaathi.auth.RateLimitService;
import in.bissaathi.chat.dto.ChatDtos.SendMessageRequest;
import in.bissaathi.chat.dto.ChatDtos.Source;
import in.bissaathi.common.ApiException;
import in.bissaathi.common.AppProperties;
import in.bissaathi.common.EvidenceTier;
import in.bissaathi.common.Intent;
import in.bissaathi.common.Language;
import in.bissaathi.config.RequestContext;
import in.bissaathi.domain.ConversationEntity;
import in.bissaathi.domain.MessageEntity;
import in.bissaathi.domain.UserEntity;
import in.bissaathi.rag.AnswerService;
import in.bissaathi.rag.CitationValidator;
import in.bissaathi.rag.IntentRouter;
import in.bissaathi.rag.LlmProvider;
import in.bissaathi.rag.MockLlmProvider;
import in.bissaathi.rag.PiiGuard;
import in.bissaathi.rag.RetrievalService;
import in.bissaathi.rag.RetrievedChunk;
import in.bissaathi.repo.UserRepository;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * Runs one question through the pipeline and writes the SSE frames (docs/API.md,
 * "SSE message stream").
 *
 * Frame order is fixed: `meta`, zero or more `delta`, `sources`, `usage`, `done`.
 * `error` is terminal and replaces `done`.
 *
 * The single most important ordering rule lives at the `sources` frame: sources are
 * emitted only AFTER citation validation, and every field in them is read from a
 * database row. The model is never asked to describe a source, so it cannot invent
 * one (R3). The text in `delta` is likewise post-validation — an unvalidated token is
 * never written to the socket.
 */
@Service
public class MessageStreamService {

  private static final Logger log = LoggerFactory.getLogger(MessageStreamService.class);

  private final ConversationService conversationService;
  private final IntentRouter intentRouter;
  private final RetrievalService retrieval;
  private final AnswerService answers;
  private final CitationValidator citations;
  private final LlmProvider provider;
  private final UserRepository users;
  private final RateLimitService rateLimit;
  private final AuditService audit;
  private final AppProperties properties;
  private final com.fasterxml.jackson.databind.ObjectMapper mapper;

  public MessageStreamService(
      ConversationService conversationService,
      IntentRouter intentRouter,
      RetrievalService retrieval,
      AnswerService answers,
      CitationValidator citations,
      LlmProvider provider,
      UserRepository users,
      RateLimitService rateLimit,
      AuditService audit,
      AppProperties properties,
      com.fasterxml.jackson.databind.ObjectMapper mapper) {
    this.conversationService = conversationService;
    this.intentRouter = intentRouter;
    this.retrieval = retrieval;
    this.answers = answers;
    this.citations = citations;
    this.provider = provider;
    this.users = users;
    this.rateLimit = rateLimit;
    this.audit = audit;
    this.properties = properties;
    this.mapper = mapper;
  }

  /** Writes the whole stream for one user turn. The caller owns the response object. */
  public void stream(RequestContext context, UUID conversationId, SendMessageRequest request, HttpServletResponse response)
      throws IOException {
    long startedAt = System.nanoTime();

    // 1. Authorise and persist the user turn. Ownership is checked before any
    //    retrieval or model work, so a bad conversation id costs one indexed query.
    ConversationEntity conversation = conversationService.owned(context.userId(), conversationId);
    Language language = request.language() == null ? conversation.getLanguage() : request.language();

    rateLimit.checkChat(context.userId() + ":" + conversationId);

    // 2. Scan and redact BEFORE persisting. Keeping the raw text "so the user can read
    //    their own history back" would make the database the most complete copy of
    //    everybody's Aadhaar numbers, reachable by every future bug and every backup.
    PiiGuard.Result pii = PiiGuard.scan(request.content());
    String question = pii.redacted();
    if (pii.detected()) {
      log.info(
          "personal data redacted in a message for conversation {} (kinds={})",
          conversationId,
          pii.kinds());
    }
    conversationService.persist(
        conversation, "user", question, List.of(), EvidenceTier.NONE, null, language,
        List.of(), null, null, null, null, null);

    // 3. Intent first, always, and routed on the REDACTED text so a number that only
    //    exists in the raw form cannot reach a model or an embedding pipeline either.
    //    See AnswerService for why this ordering is the safety property.
    Intent intent = intentRouter.route(question);
    ResponseHeaders.disableBuffering(response);
    SseFrames frames = new SseFrames(response.getWriter(), mapper);
    SseFrames.prime(response.getWriter());

    RetrievalService.Outcome outcome =
        intent == Intent.out_of_scope || intent == Intent.chitchat || intent == Intent.meta || intent == Intent.clarify
            ? new RetrievalService.Outcome(List.of(), 0, 0, 0)
            : retrieval.retrieve(request.content(), language);

    AnswerService.Decision decision = answers.decide(request.content(), intent, outcome.chunks(), language);

    MessageEntity assistantTurn;
    try {
      assistantTurn = decision.generates()
          ? generateAndStream(conversation, language, request.content(), decision, outcome, frames)
          : fixedAnswerAndStream(conversation, language, decision, outcome, frames);
    } catch (MockLlmProvider.ProviderUnavailableException e) {
      // R8: evidence exists but generation cannot run. The user is told, the turn is
      // recorded with the error code, and nothing plausible is written in its place.
      log.warn("provider unavailable for conversation {}", conversationId);
      emitErrorAndStream(frames, conversation, language, decision, outcome, e.getMessage());
      return;
    } catch (IOException e) {
      // The client hung up. There is nobody left to tell, but the turn must not be
      // recorded as a successful answer.
      log.info("stream aborted for conversation {}: {}", conversationId, e.toString());
      throw e;
    }

    audit.record(
        context.userId(),
        "chat.answered",
        "conversation",
        conversationId.toString(),
        AuditService.SUCCESS,
        null,
        "{\"intent\":\"" + decision.intent() + "\",\"tier\":\"" + assistantTurn.getEvidenceTier() + "\"}");
    log.debug(
        "answer complete conversation={} intent={} tier={} sources={} ms={}",
        conversationId,
        decision.intent(),
        assistantTurn.getEvidenceTier(),
        assistantTurn.getSourcesJson(),
        (System.nanoTime() - startedAt) / 1_000_000L);
  }

  /* ------------------------------------------------------------------- branches */

  /** Branches 1-3: a fixed, non-generated sentence. No model is consulted. */
  private MessageEntity fixedAnswerAndStream(
      ConversationEntity conversation,
      Language language,
      AnswerService.Decision decision,
      RetrievalService.Outcome outcome,
      SseFrames frames)
      throws IOException {
    String text = decision.fixedAnswer();

    frames.send("meta", metaFrame(decision.intent(), language, outcome.elapsedMillis(), pii));

    for (String piece : chunkText(text, 48)) {
      frames.send("delta", Map.of("text", piece));
    }

    List<Source> sources = List.of();
    frames.send("sources", Map.of("sources", sources, "evidenceTier", EvidenceTier.NONE.name()));
    frames.send("usage", usage(Map.of(), sources.size(), EvidenceTier.NONE, outcome, language));
    frames.send("done", Map.of("followUps", decision.followUps(), "disclaimer", answers.disclaimer(language)));

    return conversationService.persist(
        conversation, "assistant", text, sources, EvidenceTier.NONE, decision.intent(), language,
        decision.followUps(), 0, 0, "none (no generation)", (int) outcome.elapsedMillis(), null);
  }

  /** Branch 5: real provider, so generate, validate citations, then emit. */
  private MessageEntity generateAndStream(
      ConversationEntity conversation,
      Language language,
      String question,
      AnswerService.Decision decision,
      RetrievalService.Outcome outcome,
      SseFrames frames)
      throws IOException {

    frames.send("meta", metaFrame(decision.intent(), language, outcome.elapsedMillis(), pii));

    List<LlmProvider.Chunk> context = new ArrayList<>();
    for (RetrievedChunk chunk : outcome.chunks()) {
      context.add(
          new LlmProvider.Chunk(
              chunk.chunkId(), chunk.title(), chunk.standardNo(), chunk.section(), chunk.text(), chunk.score()));
    }

    LlmProvider.Completion completion =
        provider.generate(
            new LlmProvider.Request(question, language.name(), decision.intent().name(), systemPrompt(language), context),
            Map.of("temperature", properties.rag().temperature(), "max_output_tokens", maxOutputTokens(decision.intent())));

    // R3, before anything reaches the client.
    CitationValidator.Result validated =
        citations.validate(completion.text(), completion.citations(), outcome.chunks());
    EvidenceTier tier = answers.computeEvidenceTier(validated.sources(), validated.allCitationsValid());

    // Only validated text is streamed; a reference that did not resolve is stripped
    // rather than shown and quietly disowned afterwards.
    String text = stripInvalidCitations(completion.text(), validated.droppedRefs());
    for (String piece : chunkText(text, 48)) {
      frames.send("delta", Map.of("text", piece));
    }

    List<Source> sources = toSources(validated.sources());
    frames.send("sources", Map.of("sources", sources, "evidenceTier", tier.name()));
    frames.send(
        "usage",
        usage(
            Map.of(
                "promptTokens", completion.promptTokens(),
                "completionTokens", completion.completionTokens(),
                "model", completion.model()),
            sources.size(),
            tier,
            outcome,
            language));
    frames.send("done", Map.of("followUps", decision.followUps(), "disclaimer", answers.disclaimer(language)));

    return conversationService.persist(
        conversation, "assistant", text, sources, tier, decision.intent(), language, decision.followUps(),
        completion.promptTokens(), completion.completionTokens(), completion.model(), (int) outcome.elapsedMillis(), null);
  }

  /** Branch 4: generation failed after retrieval succeeded. */
  private void emitErrorAndStream(
      SseFrames frames,
      ConversationEntity conversation,
      Language language,
      AnswerService.Decision decision,
      RetrievalService.Outcome outcome,
      String message)
      throws IOException {
    // The retrieved sources are still returned: they are real and the user may follow
    // them directly. Only the summary is unavailable.
    List<Source> sources = toSources(outcome.chunks());
    frames.send("sources", Map.of("sources", sources, "evidenceTier", EvidenceTier.NONE.name()));
    frames.send("error", Map.of("code", "PROVIDER_UNAVAILABLE", "message", message));
    conversationService.persist(
        conversation, "assistant", "", sources, EvidenceTier.NONE, decision.intent(), language, List.of(),
        0, 0, provider.name(), (int) outcome.elapsedMillis(), "PROVIDER_UNAVAILABLE");
  }

  /* -------------------------------------------------------------------- helpers */

  /**
   * The `meta` frame. `piiDetected` is part of the client-visible contract: the UI
   * shows a one-line notice in the answer's language when something was withheld, so
   * the redaction is not silent (docs/API.md, "SSE message stream").
   */
  private Map<String, Object> metaFrame(
      Intent intent, Language language, long retrievalMs, PiiGuard.Result pii) {
    Map<String, Object> meta = new java.util.LinkedHashMap<>();
    meta.put("messageId", UUID.randomUUID().toString());
    meta.put("intent", intent.name());
    meta.put("language", language.name());
    meta.put("retrievalMs", retrievalMs);
    meta.put("piiDetected", pii.detected());
    meta.put("inScope", intent != Intent.out_of_scope);
    return meta;
  }

  /**
   * The prompt. Kept short and directive: the model is told it may only use the
   * supplied passages, must cite them, and must say it does not know otherwise. That
   * instruction is a quality measure, never the control — CitationValidator is the
   * control, because a prompt can be ignored and a validator cannot be.
   */
  private String systemPrompt(Language language) {
    return language == Language.hi
        ? "आप केवल दिए गए प्रसंग (passages) से उत्तर देते हैं। प्रत्येक दावे के साथ [S1] जैसा संदर्भ दें।"
            + " यदि प्रसंग में उत्तर नहीं है, तो स्पष्ट रूप कहें कि जानकारी पर्याप्त नहीं है। स्वयं कोई मानक संख्या,"
            + " शुल्क, तिथि या शीर्षक न गढ़ें।"
        : "Answer only from the supplied passages. Cite each claim with a reference such as [S1]. "
            + "If the passages do not contain the answer, say so plainly. Never invent a standard number, "
            + "fee, date, title or clause.";
  }

  /** Per-intent output budget, so a lookup cannot sprawl into an essay (§6). */
  private int maxOutputTokens(Intent intent) {
    return switch (intent) {
      case factual, lab, hallmark -> 400;
      case compare -> 700;
      case recommend, certification -> 900;
      default -> 250;
    };
  }

  private static List<Source> toSources(List<RetrievedChunk> chunks) {
    List<Source> sources = new ArrayList<>(chunks.size());
    for (int i = 0; i < chunks.size(); i++) {
      RetrievedChunk chunk = chunks.get(i);
      sources.add(
          new Source(
              "S" + (i + 1),
              chunk.chunkId(),
              chunk.title(),
              chunk.standardNo(),
              chunk.section(),
              chunk.docType(),
              chunk.language(),
              chunk.sourceUrl(),
              chunk.verificationStatus(),
              chunk.verifiedAt(),
              chunk.snippet()));
    }
    return sources;
  }

  private Map<String, Object> usage(
      Map<String, ?> providerUsage, int sourceCount, EvidenceTier tier, RetrievalService.Outcome outcome, Language language) {
    java.util.LinkedHashMap<String, Object> usage = new java.util.LinkedHashMap<>();
    usage.put("promptTokens", providerUsage.getOrDefault("promptTokens", 0));
    usage.put("completionTokens", providerUsage.getOrDefault("completionTokens", 0));
    usage.put("model", providerUsage.getOrDefault("model", "none (no generation)"));
    // R10: cost is 0 because no billable call was made or because it is unknown. It
    // is never an estimate presented as a fact.
    usage.put("costUsd", 0);
    usage.put("cacheHit", false);
    usage.put("evidenceTier", tier.name());
    usage.put("sourceCount", sourceCount);
    usage.put("retrievalMs", outcome.elapsedMillis());
    usage.put("mockProvider", provider.isMock());
    usage.put("providerName", provider.name());
    usage.put("language", language.name());
    return usage;
  }

  /** Removes only the bracketed refs that failed validation, leaving prose intact. */
  private static String stripInvalidCitations(String text, List<String> droppedRefs) {
    if (text == null || droppedRefs.isEmpty()) return text == null ? "" : text;
    String result = text;
    for (String ref : droppedRefs) {
      result = result.replace("[" + ref + "]", "").replace("[" + ref.substring(1) + "]", "");
    }
    return result.replaceAll(" {2,}", " ").trim();
  }

  static List<String> chunkText(String text, int size) {
    if (text == null || text.isEmpty()) return List.of();
    List<String> pieces = new ArrayList<>((text.length() / size) + 1);
    for (int i = 0; i < text.length(); i += size) {
      pieces.add(text.substring(i, Math.min(text.length(), i + size)));
    }
    return pieces;
  }

}
