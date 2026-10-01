import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/lib/api';
import * as admin from '@/lib/admin';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Well } from '@/components/ui/card';
import { Badge, VerificationBadge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { EmptyState, ErrorState, LoadingState, QueryState } from '@/components/ui/states';
import { Field } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, Textarea } from '@/components/ui/textarea';
import { formatDateTime, formatRelative } from '@/lib/utils';
import type { IngestionJob, KnowledgeChunkDetail, KnowledgeChunkSummary } from '@/lib/types';

/**
 * Knowledge administration (§6 #4, #11–#13, #15).
 *
 * The design rule for this whole page is that the server decides what is true and the
 * UI reports it back: a submission is a queued job, not a saved document; an approval
 * says how many chunks it published; a rejected URL says which policy refused it without
 * echoing the address. Where the API is honest about a limit — a rate limit, a metadata-only
 * restricted standard, a sweep that flags but never re-ingests — the copy keeps that
 * qualification rather than smoothing it over (R8/R10).
 */

const DOC_TYPES = ['STANDARD', 'QCO', 'PROCEDURE', 'GUIDE', 'FAQ', 'NOTIFICATION', 'LABORATORY_LIST', 'HANDBOOK', 'SCHEME', 'OTHER'];

export function AdminKnowledgePage() {
  const { t } = useTranslation();
  return (
    <div className="mx-auto w-full max-w-[64rem] px-4 py-10">
      <header>
        <h1 className="font-serif text-2xl font-semibold text-ink">{t('adminKnowledge.title')}</h1>
        <p className="mt-1 max-w-[52rem] text-[13.5px] leading-5 text-ink-muted">{t('adminKnowledge.subtitle')}</p>
        <p className="mt-3">
          <Link to="/admin" className="text-[13px] text-ink underline decoration-line-strong underline-offset-4">
            {t('adminKnowledge.backToOverview')}
          </Link>
        </p>
      </header>

      <div className="mt-6 space-y-4">
        <SubmissionCard />
        <ReviewQueueCard />
        <JobMonitorCard />
        <FreshnessCard />
        <GapsAndFeedbackCard />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- submission */

function SubmissionCard() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'text' | 'url' | 'manifest'>('text');
  const [title, setTitle] = useState('');
  const [docType, setDocType] = useState('STANDARD');
  const [language, setLanguage] = useState<'en' | 'hi'>('en');
  const [standardNo, setStandardNo] = useState('');
  const [accessLevel, setAccessLevel] = useState<'open' | 'restricted'>('open');
  const [licenseNote, setLicenseNote] = useState('');
  const [content, setContent] = useState('');
  const [url, setUrl] = useState('');
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<'idle' | 'queued' | 'done' | 'failed' | 'throttled'>('idle');
  const [job, setJob] = useState<IngestionJob | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);

  const meta = {
    title: title.trim(),
    docType,
    language,
    ...(standardNo.trim() ? { standardNo: standardNo.trim() } : {}),
    accessLevel,
    ...(licenseNote.trim() ? { licenseNote: licenseNote.trim() } : {}),
  };

  const submit = useMutation({
    mutationFn: async (): Promise<IngestionJob> => {
      setResult('idle');
      setMessage(null);
      setJob(null);
      if (mode === 'text') {
        const accepted = await admin.submitText({ ...meta, content });
        setResult('queued');
        return admin.waitForJob(accepted.job.id);
      }
      if (mode === 'url') {
        if (file) {
          const accepted = await admin.submitFile(file, meta);
          setResult('queued');
          return admin.waitForJob(accepted.job.id);
        }
        const accepted = await admin.submitUrl({ ...meta, url: url.trim() });
        setResult('queued');
        return admin.waitForJob(accepted.job.id);
      }
      const parsed = await admin.submitManifest(csv);
      setResult('queued');
      const first = parsed.queued[0];
      if (first) {
        const settled = await admin.waitForJob(first.id);
        setMessage(
          t('adminKnowledge.manifestSummary', {
            queued: parsed.queued.length,
            rejected: parsed.rejected.length,
            deferred: parsed.deferredRows,
          }),
        );
        return settled;
      }
      setMessage(
        t('adminKnowledge.manifestSummary', {
          queued: parsed.queued.length,
          rejected: parsed.rejected.length,
          deferred: parsed.deferredRows,
        }),
      );
      return parsed.rejected[0] ? failedFromRejection(parsed.rejected[0]) : first!;
    },
    onSuccess: (settled) => {
      setJob(settled);
      setResult(settled.state === 'DONE' ? 'done' : 'failed');
      void queryClient.invalidateQueries({ queryKey: ['admin'] });
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError && err.code === 'RATE_LIMITED') {
        setResult('throttled');
        setMessage(err.message);
        return;
      }
      if (err instanceof ApiError) {
        setMessage(err.fieldIssue('licenseNote') ?? err.message);
        setResult('failed');
        return;
      }
      setMessage(err instanceof Error ? err.message : String(err));
      setResult('failed');
    },
  });

  const busy = submit.isPending && result === 'queued';

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('adminKnowledge.submitTitle')}</CardTitle>
        <CardDescription>{t('adminKnowledge.submitBody')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2" role="group" aria-label={t('adminKnowledge.modeLabel')}>
          {(['text', 'url', 'manifest'] as const).map((option) => (
            <Button
              key={option}
              type="button"
              size="sm"
              variant={mode === option ? 'primary' : 'secondary'}
              aria-pressed={mode === option}
              onClick={() => setMode(option)}
            >
              {t(`adminKnowledge.modes.${option}`)}
            </Button>
          ))}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('adminKnowledge.fields.title')} htmlFor="ingest-title" required error={submit.isError && !title.trim() ? t('adminKnowledge.errors.titleRequired') : undefined}>
            {(props) => <Input {...props} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />}
          </Field>
          <Field label={t('adminKnowledge.fields.standardNo')} htmlFor="ingest-standard" hint={t('adminKnowledge.fields.standardNoHint')}>
            {(props) => <Input {...props} value={standardNo} onChange={(e) => setStandardNo(e.target.value)} placeholder="IS 10500:2012" maxLength={64} />}
          </Field>
          <Field label={t('adminKnowledge.fields.docType')} htmlFor="ingest-doctype">
            {(props) => (
              <Select {...props} value={docType} onChange={(e) => setDocType(e.target.value)}>
                {DOC_TYPES.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('adminKnowledge.fields.language')} htmlFor="ingest-language">
            {(props) => (
              <Select {...props} value={language} onChange={(e) => setLanguage(e.target.value as 'en' | 'hi')}>
                <option value="en">English</option>
                <option value="hi">हिन्दी</option>
              </Select>
            )}
          </Field>
          <Field label={t('adminKnowledge.fields.access')} htmlFor="ingest-access" hint={t('adminKnowledge.fields.accessHint')}>
            {(props) => (
              <Select {...props} value={accessLevel} onChange={(e) => setAccessLevel(e.target.value as 'open' | 'restricted')}>
                <option value="open">open</option>
                <option value="restricted">restricted</option>
              </Select>
            )}
          </Field>
          <Field
            label={t('adminKnowledge.fields.licenseNote')}
            htmlFor="ingest-licence"
            required={accessLevel === 'restricted'}
            error={accessLevel === 'restricted' && !licenseNote.trim() ? t('adminKnowledge.errors.licenceRequired') : undefined}
          >
            {(props) => <Input {...props} value={licenseNote} onChange={(e) => setLicenseNote(e.target.value)} maxLength={1000} />}
          </Field>
        </div>

        {mode === 'text' ? (
          <Field label={t('adminKnowledge.fields.content')} htmlFor="ingest-content" hint={t('adminKnowledge.fields.contentHint')}>
            {(props) => <Textarea {...props} rows={8} value={content} onChange={(e) => setContent(e.target.value)} />}
          </Field>
        ) : null}

        {mode === 'url' ? (
          <div className="space-y-3">
            <Field label={t('adminKnowledge.fields.url')} htmlFor="ingest-url" hint={t('adminKnowledge.fields.urlHint')}>
              {(props) => <Input {...props} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.bis.gov.in/…" maxLength={2048} />}
            </Field>
            <Field label={t('adminKnowledge.fields.file')} htmlFor="ingest-file" hint={t('adminKnowledge.fields.fileHint')}>
              {(props) => (
                <Input
                  {...props}
                  type="file"
                  accept=".pdf,.html,.htm,.txt,.md,.csv"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
              )}
            </Field>
          </div>
        ) : null}

        {mode === 'manifest' ? (
          <Field label={t('adminKnowledge.fields.csv')} htmlFor="ingest-csv" hint={t('adminKnowledge.fields.csvHint')}>
            {(props) => <Textarea {...props} rows={6} value={csv} onChange={(e) => setCsv(e.target.value)} />}
          </Field>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            onClick={() => submit.mutate()}
            disabled={!title.trim() || submit.isPending || (mode === 'text' && content.trim().length < 40) || (mode === 'url' && !file && url.trim().length === 0) || (mode === 'manifest' && csv.trim().length < 20)}
          >
            {submit.isPending ? t('adminKnowledge.submitting') : t('adminKnowledge.submit')}
          </Button>
          <span role="status" aria-live="polite" className="text-[12.5px] text-ink-muted">
            {result === 'idle' && !message ? t('adminKnowledge.nothingYet') : null}
            {result === 'queued' ? t('adminKnowledge.queuedNote') : null}
            {busy ? null : null}
          </span>
        </div>

        {message ? (
          <p className="rounded-md border border-line bg-paper-sunken px-3 py-2 text-[12.5px] leading-5 text-ink-muted">{message}</p>
        ) : null}

        {job ? <JobDetail job={job} /> : null}
      </CardContent>
    </Card>
  );
}

function failedFromRejection(rejected: { line: number; field?: string; reason: string }): IngestionJob {
  // The manifest path can finish without any job at all. Showing "FAILED" with the
  // row's own reason keeps the panel truthful instead of pretending a job ran.
  return {
    id: 'manifest-only',
    documentId: null,
    documentVersionId: null,
    sourceKind: 'manifest',
    sourceLabel: null,
    state: 'FAILED',
    stage: 'QUEUED',
    error: `line ${rejected.line}${rejected.field ? ` (${rejected.field})` : ''}: ${rejected.reason}`,
    warnings: [],
    attempts: 0,
    maxAttempts: 0,
    retryable: false,
    needsResubmit: true,
    chunksProduced: 0,
    requestedBy: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
  };
}

function JobDetail({ job }: { job: IngestionJob }) {
  const { t } = useTranslation();
  return (
    <Well className="space-y-2">
      <p className="flex flex-wrap items-center gap-2 text-[12.5px]">
        <StateBadge state={job.state} />
        <span className="std-no text-ink-muted">{job.stage}</span>
        <span className="text-ink-faint">
          {t('adminKnowledge.attempts', { attempts: job.attempts, max: job.maxAttempts })}
        </span>
        <span className="ml-auto text-ink-faint">{formatRelative(job.finishedAt ?? job.startedAt ?? job.createdAt, 'en')}</span>
      </p>
      {job.error ? <p className="text-[12.5px] leading-5 text-error">{job.error}</p> : null}
      {job.warnings.length > 0 ? (
        <ul className="list-disc space-y-1 pl-5 text-[12.5px] leading-5 text-warn">
          {job.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}
      <p className="text-[12.5px] text-ink-muted">
        {t('adminKnowledge.chunksProduced', { count: job.chunksProduced })}
        {job.chunksProduced > 0 ? ` ${t('adminKnowledge.pendingReviewNote')}` : ''}
      </p>
    </Well>
  );
}

function StateBadge({ state }: { state: IngestionJob['state'] }) {
  return (
    <Badge variant={state === 'DONE' ? 'verified' : state === 'FAILED' ? 'error' : state === 'RUNNING' ? 'warn' : 'neutral'}>
      {state}
    </Badge>
  );
}

/* ------------------------------------------------------------ review queue */

function ReviewQueueCard() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<KnowledgeChunkSummary | null>(null);

  const chunksQuery = useQuery({
    queryKey: ['admin', 'knowledge', 'chunks', 'PENDING_REVIEW'],
    queryFn: () => admin.listChunks({ reviewState: 'PENDING_REVIEW', limit: 50 }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('adminKnowledge.reviewTitle')}</CardTitle>
        <CardDescription>{t('adminKnowledge.reviewBody')}</CardDescription>
      </CardHeader>
      <CardContent>
        <QueryState
          isLoading={chunksQuery.isLoading}
          error={chunksQuery.error ? { message: chunksQuery.error.message } : null}
          data={chunksQuery.data}
          loadingLabel={t('common.loading')}
          errorTitle={t('states.errorTitle')}
          retryLabel={t('common.retry')}
          onRetry={() => void chunksQuery.refetch()}
          empty={(chunksQuery.data?.items.length ?? 0) === 0}
          emptyState={<EmptyState title={t('adminKnowledge.nothingToReview')} body={t('adminKnowledge.nothingToReviewBody')} />}
        >
          {(data) => (
            <>
              <p className="mb-3 text-[12.5px] text-ink-muted">{t('adminKnowledge.pendingCount', { count: data.pendingReview })}</p>
              <ul className="divide-y divide-line">
                {data.items.map((chunk) => (
                  <li key={chunk.id} className="py-3">
                    <div className="flex flex-wrap items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-serif text-[15px] font-semibold text-ink">{chunk.title}</p>
                        <p className="std-no truncate text-[12px] text-ink-faint">{chunk.headingPath ?? chunk.section ?? '—'}</p>
                        <p className="mt-1 line-clamp-3 text-[12.5px] leading-5 text-ink-muted">{chunk.preview}</p>
                        <p className="mt-1 flex flex-wrap items-center gap-2 text-[11.5px] text-ink-faint">
                          <span>{t('adminKnowledge.tokens', { count: chunk.tokenCount })}</span>
                          <span className="std-no">{chunk.language}</span>
                          {chunk.injectionFlags.length > 0 ? (
                            <Badge variant="error">{t('adminKnowledge.flagged', { count: chunk.injectionFlags.length })}</Badge>
                          ) : null}
                          {chunk.embeddingDimensions > 0 ? (
                            <Badge variant="neutral">{t('adminKnowledge.embedded', { dims: chunk.embeddingDimensions })}</Badge>
                          ) : (
                            <Badge variant="warn">{t('adminKnowledge.notEmbedded')}</Badge>
                          )}
                        </p>
                      </div>
                      <Button type="button" size="sm" variant="secondary" onClick={() => setSelected(chunk)}>
                        {t('adminKnowledge.openInspector')}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </QueryState>
      </CardContent>

      <ChunkInspector
        chunk={selected}
        onClose={() => setSelected(null)}
        onDone={() => {
          setSelected(null);
          void queryClient.invalidateQueries({ queryKey: ['admin'] });
        }}
      />
    </Card>
  );
}

function ChunkInspector({ chunk, onClose, onDone }: { chunk: KnowledgeChunkSummary | null; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const detailQuery = useQuery({
    queryKey: ['admin', 'knowledge', 'chunk', chunk?.id ?? ''],
    queryFn: () => admin.getChunk(chunk!.id),
    enabled: chunk !== null,
  });

  const decide = useMutation({
    mutationFn: async (action: 'approve' | 'reject') => {
      setError(null);
      if (!chunk) throw new Error('no chunk');
      const trimmed = note.trim();
      // A note is optional to the API, and required by the workflow: an approval with no
      // reason is a signature nobody can read back.
      return action === 'approve'
        ? (await admin.approveChunk(chunk.id, trimmed || t('adminKnowledge.defaultNote'))) as unknown as { reviewState: string }
        : (await admin.rejectChunk(chunk.id, trimmed || t('adminKnowledge.defaultNote'))) as unknown as { reviewState: string };
    },
    onSuccess: () => {
      setNote('');
      onDone();
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError && err.status === 409) {
        setError(err.message);
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    },
  });

  return (
    <Dialog open={chunk !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{chunk?.title ?? ''}</DialogTitle>
          <DialogDescription>{chunk ? `${chunk.standardNo ?? chunk.docType} · ${t('adminKnowledge.version')}` : ''}</DialogDescription>
        </DialogHeader>
        {chunk ? (
          <div className="space-y-3">
            <dl className="grid grid-cols-2 gap-2 text-[12px] text-ink-muted sm:grid-cols-4">
              <Meta label={t('adminKnowledge.meta.review')} value={chunk.reviewState} />
              <Meta label={t('adminKnowledge.meta.verification')} value={<VerificationBadge status={chunk.verificationStatus} language="en" />} />
              <Meta label={t('adminKnowledge.meta.hash')} value={<span className="std-no">{chunk.contentHash.slice(0, 12)}…</span>} />
              <Meta label={t('adminKnowledge.meta.source')} value={chunk.sourceUrl ?? t('adminKnowledge.meta.noSource')} />
            </dl>

            {chunk.injectionFlags.length > 0 ? (
              <p className="rounded-md border border-error bg-error-soft px-3 py-2 text-[12.5px] leading-5 text-error">
                {t('adminKnowledge.flagsBody')}{' '}
                {chunk.injectionFlags.map((f) => `${f.rule} (${f.severity})`).join(', ')}
              </p>
            ) : null}

            {detailQuery.isLoading ? <LoadingState label={t('common.loading')} rows={3} /> : null}
            {detailQuery.data ? <ChunkText detail={detailQuery.data} /> : null}

            <Field label={t('adminKnowledge.note')} htmlFor="review-note" hint={t('adminKnowledge.noteHint')}>
              {(props) => <Textarea {...props} rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />}
            </Field>

            {error ? (
              <p role="alert" className="rounded-md border border-error bg-error-soft px-3 py-2 text-[12.5px] leading-5 text-error">
                {error}
              </p>
            ) : null}

            <DialogFooter className="gap-2">
              <Button type="button" variant="secondary" onClick={onClose}>
                {t('common.cancel')}
              </Button>
              <Button type="button" variant="dangerOutline" onClick={() => decide.mutate('reject')} disabled={decide.isPending}>
                {t('adminKnowledge.reject')}
              </Button>
              <Button type="button" onClick={() => decide.mutate('approve')} disabled={decide.isPending}>
                {decide.isPending ? t('adminKnowledge.saving') : t('adminKnowledge.approve')}
              </Button>
            </DialogFooter>
            <p className="text-[12px] leading-5 text-ink-faint">{t('adminKnowledge.approveMeaning')}</p>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ChunkText({ detail }: { detail: KnowledgeChunkDetail }) {
  return (
    <pre className="max-h-[18rem] overflow-auto whitespace-pre-wrap rounded-md border border-line bg-paper-sunken p-3 font-sans text-[12.5px] leading-5 text-ink">
      {detail.content}
    </pre>
  );
}

function Meta({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] uppercase text-ink-faint">{label}</dt>
      <dd className="mt-0.5 text-[12.5px] text-ink">{value}</dd>
    </div>
  );
}

/* ------------------------------------------------------------------- jobs */

function JobMonitorCard() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const jobsQuery = useQuery({ queryKey: ['admin', 'ingestion', 'jobs'], queryFn: () => admin.listJobs(), refetchInterval: 5000 });

  const retry = useMutation({
    mutationFn: (id: string) => admin.retryJob(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['admin', 'ingestion', 'jobs'] }),
  });
  const [retryMessage, setRetryMessage] = useState<string | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('adminKnowledge.jobsTitle')}</CardTitle>
        <CardDescription>{t('adminKnowledge.jobsBody')}</CardDescription>
      </CardHeader>
      <CardContent>
        {jobsQuery.data && jobsQuery.data.failed > 0 ? (
          <p className="mb-3 rounded-md border border-error bg-error-soft px-3 py-2 text-[12.5px] font-semibold text-error">
            {t('admin.failedJobs', { count: jobsQuery.data.failed })}
          </p>
        ) : null}
        <QueryState
          isLoading={jobsQuery.isLoading}
          error={jobsQuery.error ? { message: jobsQuery.error.message } : null}
          data={jobsQuery.data}
          loadingLabel={t('common.loading')}
          errorTitle={t('states.errorTitle')}
          retryLabel={t('common.retry')}
          onRetry={() => void jobsQuery.refetch()}
          empty={(jobsQuery.data?.items.length ?? 0) === 0}
          emptyState={<EmptyState title={t('admin.noJobs')} body={t('admin.noJobsBody')} />}
        >
          {(data) => (
            <ul className="divide-y divide-line">
              {data.items.map((job) => (
                <li key={job.id} className="space-y-1 py-3 text-[12.5px]">
                  <p className="flex flex-wrap items-center gap-2">
                    <StateBadge state={job.state} />
                    <span className="std-no text-ink-muted">{job.stage}</span>
                    <span className="truncate text-ink">{job.sourceLabel ?? job.sourceKind}</span>
                    <span className="ml-auto text-ink-faint">{formatDateTime(job.createdAt, 'en')}</span>
                  </p>
                  {job.error ? <p className="text-[11.5px] leading-4 text-error">{job.error}</p> : null}
                  {job.warnings.length > 0 ? <p className="text-[11.5px] leading-4 text-warn">{job.warnings[0]}</p> : null}
                  {job.retryable ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        retry.mutate(job.id, {
                          onSuccess: (r) => setRetryMessage(r.message),
                          onError: (e) => setRetryMessage(e instanceof Error ? e.message : String(e)),
                        })
                      }
                    >
                      {t('adminKnowledge.retry')}
                    </Button>
                  ) : job.needsResubmit ? (
                    <span className="text-[11.5px] text-ink-faint">{t('adminKnowledge.needsResubmit')}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </QueryState>
        {retryMessage ? (
          <p role="status" aria-live="polite" className="mt-3 text-[12.5px] text-ink-muted">
            {retryMessage}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/* --------------------------------------------------- freshness, gaps, queue */

function FreshnessCard() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const freshnessQuery = useQuery({ queryKey: ['admin', 'knowledge', 'freshness'], queryFn: () => admin.freshness() });
  const sweep = useMutation({
    mutationFn: () => admin.checkFreshness(),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['admin', 'knowledge', 'freshness'] }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('adminKnowledge.freshnessTitle')}</CardTitle>
        <CardDescription>{t('adminKnowledge.freshnessBody')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button type="button" size="sm" variant="secondary" onClick={() => sweep.mutate()} disabled={sweep.isPending}>
          {sweep.isPending ? t('adminKnowledge.sweeping') : t('adminKnowledge.runSweep')}
        </Button>
        {sweep.data ? (
          <p role="status" aria-live="polite" className="text-[12.5px] text-ink-muted">
            {t('adminKnowledge.sweepResult', { count: sweep.data.checked })} — {sweep.data.note}
          </p>
        ) : null}
        {sweep.isError && sweep.error instanceof ApiError ? (
          <ErrorState title={t('states.errorTitle')} body={sweep.error.message} retryLabel={t('common.retry')} onRetry={() => sweep.mutate()} />
        ) : null}
        <QueryState
          isLoading={freshnessQuery.isLoading}
          error={freshnessQuery.error ? { message: freshnessQuery.error.message } : null}
          data={freshnessQuery.data}
          loadingLabel={t('common.loading')}
          errorTitle={t('states.errorTitle')}
          retryLabel={t('common.retry')}
          onRetry={() => void freshnessQuery.refetch()}
          empty={(freshnessQuery.data?.items.length ?? 0) === 0}
          emptyState={<EmptyState title={t('adminKnowledge.noSources')} body={t('adminKnowledge.noSourcesBody')} />}
        >
          {(data) => (
            <>
              <dl className="grid gap-3 sm:grid-cols-4">
                <Meta label={t('adminKnowledge.meta.total')} value={data.total} />
                <Meta label={t('adminKnowledge.meta.recheckable')} value={data.recheckable} />
                <Meta label={t('adminKnowledge.meta.changed')} value={data.changed} />
                <Meta label={t('adminKnowledge.meta.linkRot')} value={data.linkRot} />
              </dl>
              <ul className="divide-y divide-line">
                {data.items.slice(0, 12).map((item) => (
                  <li key={item.id} className="flex flex-wrap items-center gap-2 py-2 text-[12.5px]">
                    <span className="min-w-0 flex-1 truncate text-ink">{item.documentTitle}</span>
                    <span className="std-no truncate text-ink-faint">{item.url ?? t('adminKnowledge.meta.manual')}</span>
                    {item.lastCheckOutcome ? <Badge variant={item.lastCheckOutcome === 'UNCHANGED' ? 'verified' : 'warn'}>{item.lastCheckOutcome}</Badge> : <Badge variant="neutral">{t('adminKnowledge.neverChecked')}</Badge>}
                    <span className="text-ink-faint">{item.lastCheckedAt ? formatRelative(item.lastCheckedAt, 'en') : '—'}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </QueryState>
      </CardContent>
    </Card>
  );
}

function GapsAndFeedbackCard() {
  const { t } = useTranslation();
  const gapsQuery = useQuery({ queryKey: ['admin', 'knowledge', 'gaps'], queryFn: () => admin.gaps() });
  const feedbackQuery = useQuery({ queryKey: ['admin', 'feedback'], queryFn: () => admin.openFeedback() });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('adminKnowledge.gapsTitle')}</CardTitle>
        <CardDescription>{t('adminKnowledge.gapsBody')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {gapsQuery.isLoading ? <LoadingState label={t('common.loading')} rows={2} /> : null}
        {gapsQuery.data ? (
          gapsQuery.data.items.length === 0 ? (
            <EmptyState title={t('adminKnowledge.noGaps')} body={t('adminKnowledge.noGapsBody')} />
          ) : (
            <ul className="space-y-3">
              {gapsQuery.data.items.map((group) => (
                <li key={`${group.intent}-${group.topic ?? ''}`} className="rounded-md border border-line px-3 py-2">
                  <p className="flex flex-wrap items-center gap-2 text-[12.5px]">
                    <Badge variant="warn">{group.intent}</Badge>
                    <span className="text-ink">{group.topic ?? '—'}</span>
                    <span className="ml-auto text-ink-faint">{t('adminKnowledge.askedTimes', { count: group.count })}</span>
                  </p>
                  <ul className="mt-2 space-y-1 text-[12.5px] text-ink-muted">
                    {group.examples.map((example) => (
                      <li key={example.occurredAt}>“{example.queryText}”</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )
        ) : null}
        {gapsQuery.data ? <p className="text-[12px] leading-5 text-ink-faint">{gapsQuery.data.note}</p> : null}

        <div className="border-t border-line pt-3">
          <h3 className="font-serif text-[15px] font-semibold text-ink">{t('adminKnowledge.feedbackTitle')}</h3>
          {feedbackQuery.isLoading ? <LoadingState label={t('common.loading')} rows={2} /> : null}
          {feedbackQuery.data ? (
            <>
              <p className="mt-1 text-[12.5px] text-ink-muted">{t('adminKnowledge.feedbackOpen', { count: feedbackQuery.data.open })}</p>
              <ul className="mt-2 divide-y divide-line">
                {feedbackQuery.data.items.slice(0, 10).map((row) => (
                  <li key={row.id} className="py-2 text-[12.5px] text-ink-muted">
                    <span className="text-ink">{row.issueType ?? '—'}</span> · {row.helpful === null ? '—' : row.helpful ? t('adminKnowledge.helpfulYes') : t('adminKnowledge.helpfulNo')}
                    {row.comment ? <p className="mt-1 text-ink">“{row.comment}”</p> : null}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[12px] leading-5 text-ink-faint">{feedbackQuery.data.note}</p>
            </>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
