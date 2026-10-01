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
import { retrieve } from '../../rag/retrieve';

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
  const provider = resolveLlmProvider();

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

    // §5 steps 3–4 — retrieve (skipped for chitchat/meta/clarify per §9).
    const retrieval = decision.retrieve
      ? retrieve(store, redacted, { language: decision.language, intent: decision.intent })
      : null;

    // §5 step 2 — rolling summary + last 4 turns (§9 history budget).
    const history = recentHistory(store, conversation.id, r.user!.id);

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

    sseSend(res, 'sources', { sources: composed.sources, evidenceTier: composed.evidenceTier });
    sseSend(res, 'usage', {
      promptTokens: composed.usage.promptTokens,
      completionTokens: composed.usage.completionTokens,
      model: composed.usage.model,
      costUsd: composed.usage.costUsd,
      cacheHit: composed.usage.cacheHit,
      evidenceTier: composed.evidenceTier,
      contextTokens: retrieval?.contextTokens ?? 0,
      retrievalMs: retrieval?.latencyMs ?? null,
      kbVersion: retrieval?.kbVersion ?? store.kbVersion,
      systemPromptTokens: Math.ceil(SYSTEM_PROMPT.length / 4),
      limits: { maxContextTokens: 3000, topK: 6, llmProvider: c.LLM_PROVIDER },
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
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const rows = messages.listForConversation(store, conversationId, userId);
  return rows
    .filter((m) => m.role === 'user' || m.role === 'assistant')
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
  usage?: { promptTokens: number; completionTokens: number; costUsd: number; cacheHit: boolean };
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
