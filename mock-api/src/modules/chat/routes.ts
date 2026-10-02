import { randomUUID } from 'node:crypto';
import { Router, type Response } from 'express';
import { config } from '../../config';
import type { Language } from '../../constants';
import { conversations, messages, type MessageRow, type Store } from '../../db/store';
import { notFound } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { authenticate, type AuthenticatedRequest } from '../../security/middleware';
import {
  createConversationSchema,
  renameConversationSchema,
  sendMessageSchema,
  validateBody,
  validateParams,
} from '../../lib/validate';
import { z } from 'zod';
import { assessScope, detectPii, piiWarning, redactPii, scopeRefusal } from '../../rag/guard';
import { detectLanguage, route as routeIntent, suggestFollowUps } from '../../rag/intent';
import { composeAnswer, SYSTEM_PROMPT } from '../../rag/answer';
import { resolveLlmProvider } from '../../rag/providers';
import { rewriteToStandaloneQuery } from '../../rag/rewrite';
import { retrieve } from '../../rag/retrieve';
import { gapQueries } from '../../db/store';
import { cacheableTurn, lookupAnswer, storeAnswer } from '../../lib/answerCache';
import { recordFeedbackSchema } from '../../lib/validate';
import { feedback } from '../../db/store';
import { AUDIT_ACTIONS, recordAudit } from '../../lib/audit';
import { clientIp } from '../../lib/rateLimit';

/**
 * Conversations and the SSE message stream (features #2, #3; §5 query path).
 * Mounted at `${API_BASE_PATH}/conversations`, so paths below are relative to it.
 *
 * Every read is scoped by the caller's `user_id` inside the query (R9): a
 * conversation id belonging to someone else returns 404, not 403.
 */

const idParam = z.object({ id: z.string().min(1).max(64) });

/**
 * Express 5 types a `:param` as `string | string[]` on some route shapes, so read
 * it through one helper that normalises and validates the length.
 */
function routeId(req: { params: Record<string, unknown> }): string {
  const raw = req.params.id;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const id = typeof value === 'string' ? value.trim() : '';
  if (id.length === 0 || id.length > 64) throw notFound('Conversation');
  return id;
}

function publicConversation(c: ReturnType<typeof conversations.listForUser>[number]) {
  return {
    id: c.id,
    title: c.title,
    summary: c.summary,
    language: c.language,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

function publicMessage(m: MessageRow) {
  return {
    id: m.id,
    conversationId: m.conversationId,
    role: m.role,
    content: m.content,
    sources: m.sourcesJson,
    evidenceTier: m.evidenceTier,
    intent: m.intent,
    language: m.language,
    followUps: m.followUps,
    error: m.error,
    usage: {
      promptTokens: m.promptTokens,
      completionTokens: m.completionTokens,
      costUsd: m.costUsd,
      model: m.model,
      cacheHit: m.cacheHit,
      retrievalMs: m.retrievalMs,
    },
    createdAt: m.createdAt.toISOString(),
  };
}

/** Minimal SSE writer. `res.flushHeaders()` matters behind proxies. */
function sseInit(res: Response): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Disable proxy buffering (nginx/Vite) so tokens are not batched.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
}

function sseSend(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function chatRouter(store: Store): Router {
  const router = Router();
  router.use(authenticate(store));

  /* ---------------------------------------------------- conversation CRUD */

  router.get('/', (req, res) => {
    const r = req as AuthenticatedRequest;
    const rows = conversations.listForUser(store, r.user!.id);
    res.json({ items: rows.map(publicConversation), total: rows.length });
  });

  router.post('/', validateBody(createConversationSchema), (req, res) => {
    const r = req as AuthenticatedRequest;
    const now = new Date();
    const row = {
      id: randomUUID(),
      userId: r.user!.id,
      title: req.body.title?.trim() || (req.body.language === 'hi' ? 'नई बातचीत' : 'New conversation'),
      summary: null,
      language: req.body.language as Language,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    conversations.put(store, row);
    res.status(201).json(publicConversation(row));
  });

  router.get('/:id', validateParams(idParam), (req, res) => {
    const r = req as AuthenticatedRequest;
    // R9: ownership is part of the lookup.
    const row = conversations.byIdForUser(store, routeId(req), r.user!.id);
    if (!row) throw notFound('Conversation');
    res.json({
      ...publicConversation(row),
      messages: messages.listForConversation(store, row.id, r.user!.id).map(publicMessage),
    });
  });

  router.patch('/:id', validateParams(idParam), validateBody(renameConversationSchema), (req, res) => {
    const r = req as AuthenticatedRequest;
    const row = conversations.byIdForUser(store, routeId(req), r.user!.id);
    if (!row) throw notFound('Conversation');
    row.title = req.body.title;
    row.updatedAt = new Date();
    res.json(publicConversation(row));
  });

  router.delete('/:id', validateParams(idParam), (req, res) => {
    const r = req as AuthenticatedRequest;
    const removed = conversations.remove(store, routeId(req), r.user!.id);
    if (!removed) throw notFound('Conversation');
    res.status(204).end();
  });

  router.get('/:id/messages', validateParams(idParam), (req, res) => {
    const r = req as AuthenticatedRequest;
    const row = conversations.byIdForUser(store, routeId(req), r.user!.id);
    if (!row) throw notFound('Conversation');
    const rows = messages.listForConversation(store, row.id, r.user!.id);
    res.json({ items: rows.map(publicMessage), total: rows.length });
  });

  /* -------------------------------------------------------- SSE answering */

  router.post('/:id/messages', validateParams(idParam), validateBody(sendMessageSchema), async (req, res) => {
    // Resolved per request, not at mount: `resetProviders()` and the config the
    // tests swap in must be able to take effect without rebuilding the whole app, and a
    // provider captured at startup would silently outlive a config reload in production.
    const provider = resolveLlmProvider();
    const r = req as AuthenticatedRequest;
    const conversation = conversations.byIdForUser(store, routeId(req), r.user!.id);
    if (!conversation) throw notFound('Conversation');

    const rawContent: string = req.body.content;
    const requestedLanguage: Language | undefined = req.body.language;
    const language: Language = requestedLanguage ?? detectLanguageOrConversation(rawContent, conversation.language);

    // PII guard (§6 #7): detect before anything is logged or stored.
    const pii = detectPii(rawContent);
    const redacted = redactPii(rawContent);
    if (pii.length > 0) {
      logger.warn('user message contained personal data; redacted before storage', {
        conversationId: conversation.id,
        piiTypes: pii.map((p) => p.type),
      });
    }

    // Persist the user turn with PII redacted; the raw text is only used for this
    // turn's generation and never written to logs.
    const userRow: MessageRow = {
      id: randomUUID(),
      conversationId: conversation.id,
      userId: r.user!.id,
      role: 'user',
      content: redacted,
      sourcesJson: [],
      evidenceTier: 'NONE',
      intent: null,
      language,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: null,
      model: null,
      cacheHit: false,
      retrievalMs: null,
      followUps: [],
      error: null,
      createdAt: new Date(),
    };
    messages.put(store, userRow);

    sseInit(res);
    res.on('close', () => logger.debug('client closed SSE stream', { conversationId: conversation.id }));

    // §5 step 1 — route intent. Out-of-scope never reaches retrieval.
    const decision = routeIntent(redacted, language);
    const priorScoped = messages
      .listForConversation(store, conversation.id, r.user!.id)
      .some((m) => m.role === 'assistant' && m.evidenceTier !== 'NONE');
    const scope = assessScope(redacted, priorScoped);

    sseSend(res, 'meta', {
      messageId: userRow.id,
      intent: scope.inScope ? decision.intent : 'out_of_scope',
      language: decision.language,
      piiDetected: pii.length > 0,
      inScope: scope.inScope,
    });

    if (!scope.inScope) {
      const text = scopeRefusal(language);
      const assistantRow = persistAssistant(store, conversation.id, r.user!.id, text, {
        language,
        intent: 'out_of_scope',
        followUps: [],
        evidenceTier: 'NONE',
        model: provider.name,
      });
      sseSend(res, 'delta', { text });
      sseSend(res, 'sources', { sources: [], evidenceTier: 'NONE' });
      sseSend(res, 'done', { messageId: assistantRow.id, followUps: [] });
      res.end();
      return;
    }

    if (pii.length > 0) {
      // Surface the warning as an assistant-visible note, then continue.
      sseSend(res, 'delta', { text: `${piiWarning(language)}\n\n` });
    }

    // §5 step 2 — rolling summary + last 4 turns (§9 history budget). The turn being
    // answered is already persisted, so it has to be excluded: otherwise every question
    // arrives with itself as history, which both inflates the prompt and makes
    // `cacheableTurn`'s "no history" condition permanently false — a cache that is
    // never consulted, and a rewrite model shown the question it is being asked to
    // rewrite. `excludeMessageId` is what keeps "prior turns" meaning prior turns.
    const history = recentHistory(store, conversation.id, r.user!.id, userRow.id);

    // §9 — the cache is consulted before retrieval, because a hit means no
    // retrieval and no generation at all. Only impersonal, history-free turns
    // qualify (see lib/answerCache.ts for why that gate exists).
    const mayUseCache =
      decision.retrieve &&
      cacheableTurn({
        intent: decision.intent,
        piiDetected: pii.length > 0,
        hasHistory: history.length > 0,
        providerError: null,
      });
    const looked = mayUseCache
      ? await lookupAnswer({
          query: redacted,
          language: decision.language,
          intent: decision.intent,
          kbVersion: store.kbVersion,
        })
      : null;

    if (looked?.answer) {
      const hit = looked.answer;
      const assistantRow = persistAssistant(store, conversation.id, r.user!.id, hit.text, {
        language,
        intent: decision.intent,
        followUps: hit.followUps,
        evidenceTier: hit.evidenceTier,
        model: hit.model,
        sources: hit.sources,
        usage: {
          promptTokens: hit.promptTokens,
          completionTokens: hit.completionTokens,
          costUsd: hit.costUsd,
          cacheHit: true,
        },
        retrievalMs: null,
      });
      for (const piece of chunkText(hit.text, 48)) sseSend(res, 'delta', { text: piece });
      sseSend(res, 'sources', { sources: hit.sources, evidenceTier: hit.evidenceTier });
      sseSend(res, 'usage', {
        promptTokens: hit.promptTokens,
        completionTokens: hit.completionTokens,
        model: hit.model,
        costUsd: hit.costUsd,
        cacheHit: true,
        cacheMatch: looked.match,
        cacheSimilarity: looked.similarity,
        kbVersion: store.kbVersion,
        evidenceTier: hit.evidenceTier,
        limits: { maxContextTokens: 3000, topK: 6, llmProvider: 'cache' },
      });
      sseSend(res, 'done', { messageId: assistantRow.id, followUps: hit.followUps });
      conversation.updatedAt = new Date();
      res.end();
      return;
    }

    // §5 step 2 — a follow-up is rewritten for retrieval only; the user's own
    // words remain what is stored and what the answer model sees.
    const rewrite = decision.retrieve
      ? await rewriteToStandaloneQuery({
          provider,
          question: redacted,
          history,
          language: decision.language,
        })
      : { query: redacted, method: 'passthrough' as const, reason: 'Retrieval was skipped for this intent.', promptTokens: 0, completionTokens: 0 };

    // §5 steps 3–4 — retrieve (skipped for chitchat/meta/clarify per §9).
    const retrieval = decision.retrieve
      ? retrieve(store, rewrite.query, { language: decision.language, intent: decision.intent })
      : null;

    const c = config();
    let composed;
    try {
      composed = await composeAnswer({
        provider,
        retrieval,
        intent: decision.intent,
        language: decision.language,
        userText: redacted,
        history,
      });
    } catch (err) {
      // R8: a provider failure is surfaced, never replaced with a canned answer.
      const message = err instanceof Error ? err.message : 'Answer generation failed.';
      logger.error('generation failed', { conversationId: conversation.id, err });
      sseSend(res, 'error', { code: 'PROVIDER_UNAVAILABLE', message });
      persistAssistant(store, conversation.id, r.user!.id, '', {
        language,
        intent: decision.intent,
        followUps: [],
        evidenceTier: 'NONE',
        model: provider.name,
        error: 'PROVIDER_UNAVAILABLE',
        sources: [],
      });
      res.end();
      return;
    }

    const text = composed.text.length > 0 ? composed.text : '';

    // §6 #14 — knowledge gaps. Recorded only for questions that came back with no
    // usable evidence, and only in their redacted form. It is the coverage signal a
    // content manager needs; inventing an analytics number is not.
    if (
      composed.evidenceTier === 'NONE' &&
      decision.retrieve &&
      !['out_of_scope', 'chitchat', 'meta', 'clarify'].includes(decision.intent)
    ) {
      const now = new Date();
      gapQueries.put(store, {
        id: crypto.randomUUID(),
        userId: r.user!.id,
        conversationId: conversation.id,
        queryText: redacted.slice(0, 500),
        language: decision.language,
        intent: decision.intent,
        occurredAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }

    if (composed.providerError) {
      // R8: evidence was found but generation could not run. Say so plainly.
      sseSend(res, 'sources', { sources: composed.sources, evidenceTier: composed.evidenceTier });
      sseSend(res, 'error', composed.providerError);
      persistAssistant(store, conversation.id, r.user!.id, text, {
        language,
        intent: decision.intent,
        followUps: [],
        evidenceTier: composed.evidenceTier,
        model: provider.name,
        error: composed.providerError.code,
        sources: composed.sources,
        usage: composed.usage,
        retrievalMs: retrieval?.latencyMs ?? null,
      });
      res.end();
      return;
    }

    // Stream the validated text in small pieces so the UI can render progressively.
    // Only post-validation text is streamed — an unvalidated token never leaves the server.
    for (const piece of chunkText(text, 48)) {
      sseSend(res, 'delta', { text: piece });
    }

    if (mayUseCache) {
      storeAnswer({
        query: redacted,
        language: decision.language,
        intent: decision.intent,
        kbVersion: store.kbVersion,
        answer: {
          text,
          sources: composed.sources,
          evidenceTier: composed.evidenceTier,
          followUps: composed.followUps,
          model: composed.usage.model,
          promptTokens: composed.usage.promptTokens,
          completionTokens: composed.usage.completionTokens,
          costUsd: composed.usage.costUsd,
        },
        embedding: looked?.queryEmbedding ?? null,
      });
    }

    sseSend(res, 'sources', { sources: composed.sources, evidenceTier: composed.evidenceTier });
    sseSend(res, 'usage', {
      promptTokens: composed.usage.promptTokens + rewrite.promptTokens,
      completionTokens: composed.usage.completionTokens + rewrite.completionTokens,
      model: composed.usage.model,
      // null means "this deployment has not configured pricing", which the UI must
      // render as no cost rather than as free (R10).
      costUsd: composed.usage.costUsd,
      cacheHit: composed.usage.cacheHit,
      evidenceTier: composed.evidenceTier,
      truncated: composed.truncated,
      contextTokens: retrieval?.contextTokens ?? 0,
      retrievalMs: retrieval?.latencyMs ?? null,
      kbVersion: retrieval?.kbVersion ?? store.kbVersion,
      systemPromptTokens: Math.ceil(SYSTEM_PROMPT.length / 4),
      rewrite: { method: rewrite.method, reason: rewrite.reason },
      droppedSentences: composed.validation?.removedSentences.length ?? 0,
      limits: { maxContextTokens: 3000, topK: 6, llmProvider: c.LLM_PROVIDER, cacheTtlSeconds: c.ANSWER_CACHE_TTL_SECONDS },
    });

    const followUps =
      composed.followUps.length > 0 ? composed.followUps : suggestFollowUps(decision.intent, language);

    const assistantRow = persistAssistant(store, conversation.id, r.user!.id, text, {
      language,
      intent: decision.intent,
      followUps,
      evidenceTier: composed.evidenceTier,
      model: composed.usage.model,
      sources: composed.sources,
      usage: composed.usage,
      retrievalMs: retrieval?.latencyMs ?? null,
    });

    // Keep the conversation title derived from the first user turn (no invented titles).
    if (conversation.title.startsWith('New conversation') || conversation.title === 'नई बातचीत') {
      conversation.title = redacted.slice(0, 60).trim();
    }
    conversation.summary = redacted.slice(0, 200);
    conversation.updatedAt = new Date();

    sseSend(res, 'done', { messageId: assistantRow.id, followUps });
    res.end();
  });

  /* ------------------------------------------------- answer feedback (§6 #15) */

  /**
   * Thumbs + reason on an assistant message (§6 #15). Ownership is checked through
   * the *message* row, so a foreign message id is a 404 rather than a 403 (R9).
   * Feedback about a wrong answer is the highest-value signal for the golden eval
   * set, which is why `issueType` is a controlled list rather than free text.
   */
  router.post(
    '/:id/messages/:messageId/feedback',
    validateParams(z.object({ id: z.string().min(1).max(64), messageId: z.string().min(1).max(64) })),
    validateBody(recordFeedbackSchema),
    (req, res) => {
      const r = req as AuthenticatedRequest;
      const params = req.params as unknown as { id: string; messageId: string };
      const conversation = conversations.byIdForUser(store, params.id, r.user!.id);
      if (!conversation) throw notFound('Conversation');
      const message = messages
        .listForConversation(store, conversation.id, r.user!.id)
        .find((m) => m.id === params.messageId && m.role === 'assistant');
      if (!message) throw notFound('Message');

      const body = req.body as z.infer<typeof recordFeedbackSchema>;
      // One row per user per message: a second submission revises the first rather
      // than inflating the count of complaints.
      const existing = feedback.forMessage(store, message.id).find((f) => f.userId === r.user!.id);
      const now = new Date();
      const row = feedback.put(store, {
        id: existing?.id ?? crypto.randomUUID(),
        userId: r.user!.id,
        messageId: message.id,
        conversationId: conversation.id,
        helpful: body.helpful ?? null,
        rating: body.rating ?? null,
        issueType: body.issueType ?? null,
        comment: body.comment ?? null,
        resolved: false,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });

      recordAudit(store, {
        actorUserId: r.user!.id,
        actorRoles: r.user!.roles,
        action: AUDIT_ACTIONS.FEEDBACK_RECORDED,
        entityType: 'message',
        entityId: message.id,
        ip: clientIp(req),
        metadata: { helpful: row.helpful, issueType: row.issueType },
      });

      res.status(existing ? 200 : 201).json({
        id: row.id,
        messageId: row.messageId,
        helpful: row.helpful,
        rating: row.rating,
        issueType: row.issueType,
        comment: row.comment,
        createdAt: row.createdAt.toISOString(),
        // Honest framing: the row is recorded, and whether anyone acts on it is a
        // team process, not something this API can promise.
        note: 'Recorded for the knowledge team. It does not change this answer.',
      });
    },
  );

  return router;
}

/** Detects the language of this turn, falling back to the conversation's language. */
function detectLanguageOrConversation(text: string, fallback: Language): Language {
  if (text.trim().length === 0) return fallback;
  const detected = detectLanguage(text);
  // An explicit user preference on the conversation wins for Latin-script text,
  // where detection is genuinely ambiguous (romanised Hindi vs English).
  return detected === 'hi' ? 'hi' : fallback;
}

/** §9: rolling summary (<=150 tokens) + last 4 turns. */
function recentHistory(
  store: Store,
  conversationId: string,
  userId: string,
  excludeMessageId?: string,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const rows = messages.listForConversation(store, conversationId, userId);
  return rows
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.id !== excludeMessageId)
    .slice(-4)
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
}

function chunkText(text: string, size: number): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

interface PersistOpts {
  language: Language;
  intent: string | null;
  followUps: string[];
  evidenceTier: MessageRow['evidenceTier'];
  model: string | null;
  sources?: MessageRow['sourcesJson'];
  usage?: { promptTokens: number; completionTokens: number; costUsd: number | null; cacheHit: boolean };
  retrievalMs?: number | null;
  error?: string | null;
}

function persistAssistant(
  store: Store,
  conversationId: string,
  userId: string,
  content: string,
  opts: PersistOpts,
): MessageRow {
  const row: MessageRow = {
    id: randomUUID(),
    conversationId,
    userId,
    role: 'assistant',
    content,
    sourcesJson: opts.sources ?? [],
    evidenceTier: opts.evidenceTier,
    intent: (opts.intent as MessageRow['intent']) ?? null,
    language: opts.language,
    promptTokens: opts.usage?.promptTokens ?? 0,
    completionTokens: opts.usage?.completionTokens ?? 0,
    costUsd: opts.usage?.costUsd ?? null,
    model: opts.model,
    cacheHit: opts.usage?.cacheHit ?? false,
    retrievalMs: opts.retrievalMs ?? null,
    followUps: opts.followUps,
    error: opts.error ?? null,
    createdAt: new Date(),
  };
  messages.put(store, row);
  return row;
}
