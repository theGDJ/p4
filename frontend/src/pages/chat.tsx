import * as React from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { apiFetch, streamMessage, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge, TierBadge } from '@/components/ui/badge';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { Skeleton } from '@/components/ui/skeleton';
import { EvidenceRail, EvidenceSheet, TIER_LABEL_KEY } from '@/components/evidence-rail';
import { InformationalLabel, MockProviderBadge } from '@/components/mock-badge';
import { staggerContainer, staggerItem, transitionBase } from '@/lib/motion';
import { cn, formatRelative, truncateWords } from '@/lib/utils';
import type {
  Conversation,
  ConversationDetail,
  EvidenceTier,
  Message,
  SourceSnapshot,
  SseUsageFrame,
} from '@/lib/types';

/**
 * Chat (feature #2) with the evidence rail (feature #3).
 *
 * Streaming is POST + ReadableStream, because `EventSource` cannot carry an
 * Authorization header. Deltas are appended to a buffer and rendered live; the
 * sources frame arrives separately and is validated server-side before it is sent,
 * so nothing in the rail is model-authored (R3).
 */

interface StreamState {
  active: boolean;
  conversationId: string | null;
  text: string;
  sources: SourceSnapshot[];
  tier: EvidenceTier | null;
  intent: string | null;
  usage: SseUsageFrame | null;
  followUps: string[];
  error: { code: string; message: string } | null;
}

const idleStream: StreamState = {
  active: false,
  conversationId: null,
  text: '',
  sources: [],
  tier: null,
  intent: null,
  usage: null,
  followUps: [],
  error: null,
};

export function ChatPage() {
  const { t, i18n } = useTranslation();
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const reduceMotion = useReducedMotion();

  const [selectedId, setSelectedId] = React.useState<string | null>(params.get('c'));
  const [draft, setDraft] = React.useState('');
  const [stream, setStream] = React.useState<StreamState>(idleStream);
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const [copiedId, setCopiedId] = React.useState<string | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);
  const composerRef = React.useRef<HTMLTextAreaElement>(null);
  const scrollerRef = React.useRef<HTMLDivElement>(null);

  const conversationsQuery = useQuery({
    queryKey: ['conversations'],
    queryFn: () => apiFetch<{ items: Conversation[]; total: number }>('/conversations'),
  });

  const conversationQuery = useQuery({
    queryKey: ['conversations', selectedId],
    queryFn: () => apiFetch<ConversationDetail>(`/conversations/${selectedId}`),
    enabled: Boolean(selectedId),
  });

  const messages = conversationQuery.data?.messages ?? [];

  /* A draft carried over from the landing page becomes the first question. */
  const pendingDraft = params.get('q');
  const draftHandled = React.useRef<string | null>(null);

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/conversations/${id}`, { method: 'DELETE' }),
    onSuccess: (_data, id) => {
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      queryClient.removeQueries({ queryKey: ['conversations', id] });
      if (selectedId === id) {
        setSelectedId(null);
        setParams({}, { replace: true });
      }
    },
  });

  const renameMutation = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      apiFetch<Conversation>(`/conversations/${id}`, { method: 'PATCH', body: { title } }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['conversations'] }),
  });

  const send = React.useCallback(
    async (content: string, intoConversationId: string | null) => {
      const question = content.trim();
      if (!question || stream.active) return;

      let conversationId = intoConversationId;
      try {
        if (!conversationId) {
          const created = await apiFetch<Conversation>('/conversations', {
            method: 'POST',
            body: { title: truncateWords(question, 120), language: i18n.language === 'hi' ? 'hi' : 'en' },
          });
          conversationId = created.id;
          setSelectedId(created.id);
          setParams({ c: created.id }, { replace: true });
          void queryClient.invalidateQueries({ queryKey: ['conversations'] });
        }
      } catch (error) {
        setStream({ ...idleStream, error: describeError(error, t('states.errorTitle')) });
        return;
      }

      const controller = new AbortController();
      abortRef.current = controller;
      setStream({ ...idleStream, active: true, conversationId });

      try {
        await streamMessage(
          conversationId,
          question,
          {
            onMeta: (frame) => setStream((s) => ({ ...s, intent: frame.intent })),
            onDelta: (text) => setStream((s) => ({ ...s, text: s.text + text })),
            onSources: (frame) => setStream((s) => ({ ...s, sources: frame.sources, tier: frame.evidenceTier })),
            onUsage: (frame) => setStream((s) => ({ ...s, usage: frame })),
            onDone: (frame) => setStream((s) => ({ ...s, followUps: frame.followUps })),
            // R8: a provider error is surfaced, never replaced by a canned answer.
            onError: (frame) => setStream((s) => ({ ...s, error: frame })),
          },
          controller.signal,
        );
      } catch (error) {
        if ((error as Error)?.name !== 'AbortError') {
          setStream((s) => ({ ...s, error: describeError(error, t('chat.errorTitle')) }));
        }
      } finally {
        setStream((s) => ({ ...s, active: false }));
        abortRef.current = null;
        void queryClient.invalidateQueries({ queryKey: ['conversations', conversationId] });
        void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      }
    },
    [stream.active, i18n.language, queryClient, setParams, t],
  );

  /* Run the landing-page draft exactly once. */
  React.useEffect(() => {
    if (!pendingDraft || draftHandled.current === pendingDraft) return;
    draftHandled.current = pendingDraft;
    setDraft('');
    void send(pendingDraft, null);
    // Drop ?q= from the URL so a refresh does not re-ask the same question.
    const next = new URLSearchParams(params);
    next.delete('q');
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingDraft]);

  React.useEffect(() => {
    if (!stream.active) return;
    const node = scrollerRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [stream.text, stream.active]);

  React.useEffect(() => () => abortRef.current?.abort(), []);

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const value = draft;
    setDraft('');
    void send(value, selectedId);
  };

  const stop = () => abortRef.current?.abort();

  const copy = async (message: Message) => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopiedId(message.id);
      window.setTimeout(() => setCopiedId(null), 1800);
    } catch {
      // Clipboard can be blocked; failing quietly here is acceptable because the
      // text is on screen and selectable.
    }
  };

  const rename = (conversation: Conversation) => {
    const nextTitle = window.prompt(t('chat.renamePrompt'), conversation.title);
    if (nextTitle && nextTitle.trim() && nextTitle.trim() !== conversation.title) {
      renameMutation.mutate({ id: conversation.id, title: nextTitle.trim().slice(0, 160) });
    }
  };

  const remove = (conversation: Conversation) => {
    if (window.confirm(`${t('chat.deleteConfirmTitle')}\n\n${t('chat.deleteConfirmBody')}`)) {
      deleteMutation.mutate(conversation.id);
    }
  };

  return (
    <div className="mx-auto flex h-[calc(100vh-3.5rem-8.5rem)] w-full max-w-[100rem] gap-0 px-0 sm:px-4">
      {/* ---------------------------------------------------- conversation list */}
      <nav
        aria-label={t('nav.conversations')}
        className="hidden w-64 shrink-0 flex-col border-r border-line md:flex"
      >
        <div className="border-b border-line p-3">
          <Button
            className="w-full"
            onClick={() => {
              setSelectedId(null);
              setStream(idleStream);
              setParams({}, { replace: true });
              composerRef.current?.focus();
            }}
          >
            <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true">
              <path d="M8 3v10M3 8h10" strokeLinecap="round" />
            </svg>
            {t('nav.newChat')}
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {conversationsQuery.isLoading ? (
            <LoadingState label={t('common.loading')} rows={4} />
          ) : conversationsQuery.isError ? (
            <ErrorState
              title={t('states.errorTitle')}
              body={describeError(conversationsQuery.error, '').message}
              onRetry={() => void conversationsQuery.refetch()}
              retryLabel={t('common.retry')}
            />
          ) : (conversationsQuery.data?.items.length ?? 0) === 0 ? (
            <EmptyState title={t('chat.conversationListEmpty')} body={t('chat.conversationListEmptyBody')} />
          ) : (
            <ul className="space-y-1">
              {conversationsQuery.data?.items.map((conversation) => {
                const active = conversation.id === selectedId;
                return (
                  <li key={conversation.id}>
                    <div
                      className={cn(
                        'group flex items-start gap-1 rounded-sm px-2 py-1.5 transition-colors duration-150 ease-out',
                        active ? 'bg-navy-soft' : 'hover:bg-paper-sunken',
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedId(conversation.id);
                          setStream(idleStream);
                          setParams({ c: conversation.id }, { replace: true });
                        }}
                        aria-current={active ? 'true' : undefined}
                        className="min-w-0 flex-1 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal"
                      >
                        <span className={cn('block truncate text-[13px]', active ? 'font-semibold text-ink' : 'text-ink')}>
                          {conversation.title}
                        </span>
                        <span className="block text-[11px] text-ink-muted">
                          {formatRelative(conversation.updatedAt, i18n.language)}
                        </span>
                      </button>
                      <span className="flex shrink-0 gap-0.5 opacity-0 transition-opacity duration-150 ease-out group-focus-within:opacity-100 group-hover:opacity-100">
                        <IconAction label={t('chat.rename')} onClick={() => rename(conversation)}>
                          <path d="M11.2 2.8 13.2 4.8 5.6 12.4 2.9 13.1l.7-2.7 7.6-7.6Z" strokeLinejoin="round" />
                        </IconAction>
                        <IconAction label={t('chat.delete')} onClick={() => remove(conversation)} danger>
                          <path d="M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.6 8h4.8l.6-8" strokeLinecap="round" strokeLinejoin="round" />
                        </IconAction>
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </nav>

      {/* ------------------------------------------------------- message column */}
      <section aria-label={t('chat.title')} className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-line bg-paper-raised px-4 py-2 lg:hidden">
          <MockProviderBadge />
          <span className="ml-auto text-[11.5px] text-ink-muted">{t('common.disclaimer')}</span>
        </div>

        <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
          <div className="mx-auto max-w-3xl">
            {conversationQuery.isLoading && selectedId ? (
              <LoadingState label={t('common.loading')} rows={5} />
            ) : conversationQuery.isError ? (
              <ErrorState
                title={t('states.errorTitle')}
                body={describeError(conversationQuery.error, '').message}
                onRetry={() => void conversationQuery.refetch()}
                retryLabel={t('common.retry')}
              />
            ) : messages.length === 0 && !stream.active ? (
              <div className="mx-auto max-w-xl">
                <EmptyState
                  title={t('chat.emptyTitle')}
                  body={t('chat.emptyBody')}
                  icon={
                    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                      <path d="M3 5.5h14M3 10h14M3 14.5h9" strokeLinecap="round" />
                    </svg>
                  }
                />
                <p className="mt-4 text-[13px] leading-5 text-ink-muted">{t('chat.tierNone')}</p>
              </div>
            ) : (
              <motion.ol
                role="list"
                className="space-y-5"
                initial={reduceMotion ? false : 'initial'}
                animate={reduceMotion ? undefined : 'animate'}
                variants={reduceMotion ? undefined : staggerContainer(0.03)}
              >
                {messages.map((message) => (
                  <motion.li
                    key={message.id}
                    variants={reduceMotion ? undefined : staggerItem}
                    transition={reduceMotion ? { duration: 0 } : transitionBase}
                  >
                    <MessageBubble
                      message={message}
                      onCopy={() => void copy(message)}
                      copied={copiedId === message.id}
                      onOpenSources={() => setSheetOpen(true)}
                      copyLabel={t('chat.copy')}
                      copiedLabel={t('chat.copied')}
                      sourcesLabel={t('citations.title')}
                      tierLabel={message.evidenceTier ? t(TIER_LABEL_KEY[message.evidenceTier]) : null}
                      informationalLabel={t('chat.informational')}
                    />
                  </motion.li>
                ))}

                {stream.active || stream.text || stream.error ? (
                  <motion.li variants={reduceMotion ? undefined : staggerItem}>
                    <StreamingBubble
                      stream={stream}
                      onOpenSources={() => setSheetOpen(true)}
                      sourcesLabel={t('citations.title')}
                      thinkingLabel={t('chat.thinking')}
                      errorTitle={t('chat.errorTitle')}
                      errorBody={t('chat.errorBody')}
                      providerErrorTitle={t('chat.providerErrorTitle')}
                      informationalLabel={t('chat.informational')}
                      tierLabelKey={TIER_LABEL_KEY}
                      translate={t}
                    />
                  </motion.li>
                ) : null}
              </motion.ol>
            )}

            {/* Follow-up chips (§6 #2). Real buttons: they send the question. */}
            <AnimatePresence>
              {stream.followUps.length > 0 && !stream.active ? (
                <motion.div
                  initial={reduceMotion ? false : { opacity: 0, y: 4 }}
                  animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
                  exit={reduceMotion ? undefined : { opacity: 0 }}
                  transition={reduceMotion ? { duration: 0 } : transitionBase}
                  className="mt-5"
                >
                  <p className="mb-2 text-[12.5px] font-semibold text-ink-muted">{t('chat.followUpsTitle')}</p>
                  <ul className="flex flex-wrap gap-2">
                    {stream.followUps.map((question) => (
                      <li key={question}>
                        <button
                          type="button"
                          onClick={() => void send(question, selectedId)}
                          className="rounded-sm border border-line-strong bg-paper-raised px-3 py-1.5 text-left text-[13px] text-ink transition-colors duration-150 ease-out hover:border-teal hover:bg-teal-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal"
                        >
                          {question}
                        </button>
                      </li>
                    ))}
                  </ul>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        </div>

        {/* ------------------------------------------------------------ composer */}
        <form onSubmit={onSubmit} className="border-t border-line bg-paper-raised px-4 py-3">
          <div className="mx-auto max-w-3xl">
            <label htmlFor="composer" className="mb-1.5 block text-[12.5px] font-semibold text-ink">
              {t('chat.composerLabel')}
            </label>
            <div className="flex items-end gap-2">
              <Textarea
                id="composer"
                ref={composerRef}
                rows={2}
                value={draft}
                maxLength={4000}
                disabled={stream.active}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    onSubmit(event);
                  }
                }}
                placeholder={t('chat.composerPlaceholder')}
                className="max-h-40 min-h-[3.5rem] flex-1"
              />
              {stream.active ? (
                <Button type="button" variant="secondary" size="lg" onClick={stop}>
                  {t('chat.stop')}
                </Button>
              ) : (
                <Button type="submit" size="lg" disabled={draft.trim().length === 0}>
                  {t('chat.send')}
                </Button>
              )}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
              <InformationalLabel />
              <span className="hidden sm:inline">
                <MockProviderBadge />
              </span>
              {stream.usage ? <UsageLine usage={stream.usage} label={t('chat.usageTitle')} /> : null}
            </div>
          </div>
        </form>
      </section>

      {/* ------------------------------------------------------- evidence rail */}
      <EvidenceRail
        sources={stream.sources.length > 0 ? stream.sources : lastAssistantSources(messages)}
        tier={stream.tier ?? lastAssistantTier(messages)}
        className="hidden w-80 shrink-0 border-l lg:flex xl:w-96"
      />

      {/* Mobile: the same evidence in a bottom sheet (§11). */}
      <EvidenceSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        sources={stream.sources.length > 0 ? stream.sources : lastAssistantSources(messages)}
        tier={stream.tier ?? lastAssistantTier(messages)}
      />
    </div>
  );
}

/* --------------------------------------------------------------- components */

function lastAssistantSources(messages: Message[]): SourceSnapshot[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === 'assistant') return message.sources;
  }
  return [];
}

function lastAssistantTier(messages: Message[]): EvidenceTier | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === 'assistant') return message.evidenceTier;
  }
  return null;
}

function describeError(error: unknown, fallbackTitle: string): { code: string; message: string; traceRef?: string } {
  if (error instanceof ApiError) return { code: error.code, message: error.message, traceRef: error.traceRef };
  return { code: 'UNKNOWN', message: error instanceof Error ? error.message : fallbackTitle };
}

function IconAction({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        'rounded-sm p-1 transition-colors duration-150 ease-out focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-teal',
        danger ? 'text-ink-muted hover:bg-error-soft hover:text-error' : 'text-ink-muted hover:bg-paper-sunken hover:text-ink',
      )}
    >
      <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        {children}
      </svg>
    </button>
  );
}

function UsageLine({ usage, label }: { usage: SseUsageFrame; label: string }) {
  return (
    <span className="std-no text-[11px] text-ink-faint" title={label}>
      {usage.model} · in {usage.promptTokens} · out {usage.completionTokens} · ctx {usage.contextTokens} ·{' '}
      {usage.retrievalMs ?? 0}ms
    </span>
  );
}

function MessageBubble({
  message,
  onCopy,
  copied,
  onOpenSources,
  copyLabel,
  copiedLabel,
  sourcesLabel,
  tierLabel,
  informationalLabel,
}: {
  message: Message;
  onCopy: () => void;
  copied: boolean;
  onOpenSources: () => void;
  copyLabel: string;
  copiedLabel: string;
  sourcesLabel: string;
  tierLabel: string | null;
  informationalLabel: string;
}) {
  const isUser = message.role === 'user';
  return (
    <article className={cn('flex flex-col gap-1.5', isUser && 'items-end')}>
      <header className="flex items-center gap-2 text-[11.5px] text-ink-muted">
        <span className="font-semibold text-ink">{isUser ? '—' : 'BIS-Saathi'}</span>
        {message.evidenceTier && !isUser ? <TierBadge tier={message.evidenceTier} label={message.evidenceTier} /> : null}
      </header>

      <div
        lang={message.language}
        className={cn(
          'max-w-[46rem] whitespace-pre-wrap rounded-md border px-3.5 py-2.5 text-[14.5px] leading-6',
          isUser ? 'border-line bg-paper-sunken text-ink' : 'border-line bg-paper-raised text-ink',
        )}
      >
        {message.content}
      </div>

      {!isUser ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onCopy} aria-label={copyLabel}>
            <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <rect x="5.5" y="5.5" width="8" height="8" rx="1" />
              <path d="M10.5 3.5h-7a1 1 0 0 0-1 1v7" strokeLinecap="round" />
            </svg>
            {copied ? copiedLabel : copyLabel}
          </Button>
          <Button variant="ghost" size="sm" onClick={onOpenSources} className="lg:hidden">
            {sourcesLabel}
            <Badge variant="neutral">{message.sources.length}</Badge>
          </Button>
          {message.error ? <Badge variant="error">{message.error}</Badge> : null}
          {tierLabel && !message.error ? <span className="sr-only">{tierLabel}</span> : null}
          <span className="hidden sm:inline text-[11.5px] text-ink-faint">{informationalLabel}</span>
        </div>
      ) : null}
    </article>
  );
}

function StreamingBubble({
  stream,
  onOpenSources,
  sourcesLabel,
  thinkingLabel,
  errorTitle,
  errorBody,
  providerErrorTitle,
  informationalLabel,
  tierLabelKey,
  translate,
}: {
  stream: StreamState;
  onOpenSources: () => void;
  sourcesLabel: string;
  thinkingLabel: string;
  errorTitle: string;
  errorBody: string;
  providerErrorTitle: string;
  informationalLabel: string;
  tierLabelKey: Record<EvidenceTier, string>;
  translate: (key: string) => string;
}) {
  const showThinking = stream.active && !stream.text && !stream.error;
  return (
    <article className="flex flex-col gap-1.5">
      <header className="flex items-center gap-2 text-[11.5px] text-ink-muted">
        <span className="font-semibold text-ink">BIS-Saathi</span>
        {stream.tier ? <TierBadge tier={stream.tier} label={stream.tier} /> : null}
        {stream.active ? (
          <span role="status" aria-live="polite" className="text-ink-muted">
            {stream.text ? translate('chat.streaming') : thinkingLabel}
          </span>
        ) : null}
      </header>

      {stream.error ? (
        <ErrorState
          title={stream.error.code === 'PROVIDER_UNAVAILABLE' ? providerErrorTitle : errorTitle}
          body={`${stream.error.message} ${errorBody}`}
          detail={stream.error.code}
        />
      ) : null}

      {stream.text ? (
        <div className="max-w-[46rem] rounded-md border border-line bg-paper-raised px-3.5 py-2.5 text-[14.5px] leading-6 whitespace-pre-wrap text-ink">
          {stream.text}
          {stream.active ? (
            <span aria-hidden="true" className="ml-0.5 inline-block h-4 w-0.5 animate-pulse bg-teal align-middle" />
          ) : null}
        </div>
      ) : showThinking ? (
        <div className="max-w-[46rem] rounded-md border border-line bg-paper-raised px-3.5 py-3">
          <Skeleton className="h-3.5 w-2/3" />
          <Skeleton className="mt-2 h-3.5 w-1/2" />
        </div>
      ) : null}

      {!stream.active && !stream.error && stream.sources.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onOpenSources} className="lg:hidden">
            {sourcesLabel}
            <Badge variant="neutral">{stream.sources.length}</Badge>
          </Button>
          <span className="text-[11.5px] text-ink-faint">{informationalLabel}</span>
          {stream.tier ? <span className="sr-only">{translate(tierLabelKey[stream.tier])}</span> : null}
        </div>
      ) : null}

      {!stream.active && stream.error && stream.sources.length > 0 ? (
        <Button variant="ghost" size="sm" onClick={onOpenSources} className="self-start lg:hidden">
          {sourcesLabel}
          <Badge variant="neutral">{stream.sources.length}</Badge>
        </Button>
      ) : null}
    </article>
  );
}
