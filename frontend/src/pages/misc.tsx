import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { apiFetch, ApiError } from '@/lib/api';
import { useSession } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Well } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { Skeleton } from '@/components/ui/skeleton';
import { InformationalLabel } from '@/components/mock-badge';
import { cn, formatDateTime, formatRelative } from '@/lib/utils';
import type { AuditLogsResponse, Conversation, IngestionJobsResponse, KnowledgeStatsResponse } from '@/lib/types';

/* ------------------------------------------------------------------- splash */

/**
 * Shown while the session is being restored. Deliberately not a bare spinner: it
 * keeps the masthead identity so the transition does not flash to white.
 */
export function BootScreen({ label }: { label: string }) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-3 bg-paper px-4 py-16">
      <span role="status" aria-live="polite" className="sr-only">
        {label}
      </span>
      <span
        aria-hidden="true"
        className="flex size-10 items-center justify-center rounded-sm border border-saffron bg-navy"
      >
        <svg viewBox="0 0 20 20" className="size-5 text-paper-raised" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M4 4.5h12M4 8h12M4 11.5h8M4 15h5" strokeLinecap="round" />
        </svg>
      </span>
      <Skeleton className="h-3 w-28" />
    </div>
  );
}

/* --------------------------------------------------------------- not found */

export function NotFoundPage({ path }: { path: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <div className="mx-auto w-full max-w-lg px-4 py-20 text-center">
      <p className="std-no font-serif text-5xl font-semibold text-ink-faint">404</p>
      <h1 className="mt-3 font-serif text-xl font-semibold text-ink">{t('states.notFoundTitle')}</h1>
      <p className="mt-2 text-[13.5px] leading-5 text-ink-muted">{t('states.notFoundBody')}</p>
      {/* The attempted path is echoed so a broken link is diagnosable. It is
          rendered as text — never as HTML — so it cannot inject markup. */}
      <p className="std-no mt-3 break-all text-[12px] text-ink-faint">{path}</p>
      <div className="mt-6 flex justify-center gap-2">
        <Button variant="secondary" onClick={() => navigate(-1)}>
          {t('common.back')}
        </Button>
        <Button asChild>
          <Link to="/">{t('nav.home')}</Link>
        </Button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- dashboard */

export function DashboardPage() {
  const { t, i18n } = useTranslation();
  const { user, hasRole } = useSession();
  const navigate = useNavigate();

  const conversationsQuery = useQuery({
    queryKey: ['conversations'],
    queryFn: () => apiFetch<{ items: Conversation[]; total: number }>('/conversations?limit=6'),
  });

  if (!user) return <LoadingState label={t('common.loading')} rows={4} />;

  const recent = conversationsQuery.data?.items ?? [];
  const errorMessage = conversationsQuery.error instanceof ApiError ? conversationsQuery.error.message : undefined;

  return (
    <div className="mx-auto w-full max-w-[64rem] px-4 py-10">
      <header>
        <h1 className="font-serif text-2xl font-semibold text-ink">
          {t('dashboard.greeting', { name: user.fullName })}
        </h1>
        <p className="mt-1 text-[13.5px] text-ink-muted">{t('dashboard.subtitle')}</p>
      </header>

      <div className="mt-6 grid gap-4 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>{t('dashboard.recentActivity')}</CardTitle>
              <CardDescription>{t('dashboard.recentActivityBody')}</CardDescription>
            </CardHeader>
            <CardContent>
              {conversationsQuery.isLoading ? (
                <LoadingState label={t('common.loading')} rows={3} />
              ) : conversationsQuery.isError ? (
                <ErrorState
                  title={t('states.errorTitle')}
                  body={errorMessage}
                  onRetry={() => void conversationsQuery.refetch()}
                  retryLabel={t('common.retry')}
                />
              ) : recent.length === 0 ? (
                <EmptyState
                  title={t('chat.conversationListEmpty')}
                  body={t('chat.conversationListEmptyBody')}
                  action={
                    <Button asChild>
                      <Link to="/chat">{t('nav.newChat')}</Link>
                    </Button>
                  }
                />
              ) : (
                <ul className="divide-y divide-line">
                  {recent.map((conversation) => (
                    <li key={conversation.id}>
                      <Link
                        to={`/chat?c=${conversation.id}`}
                        className="flex items-start gap-3 rounded-sm px-1 py-2.5 transition-colors duration-150 ease-out hover:bg-paper-sunken focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13.5px] font-medium text-ink">{conversation.title}</span>
                          <span className="block text-[11.5px] text-ink-muted">
                            {formatRelative(conversation.updatedAt, i18n.language)}
                          </span>
                          {conversation.summary ? (
                            <span className="mt-0.5 block truncate text-[11.5px] text-ink-faint">{conversation.summary}</span>
                          ) : null}
                        </span>
                        <Badge variant="neutral">{conversation.language.toUpperCase()}</Badge>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('dashboard.usage')}</CardTitle>
              <CardDescription>{t('dashboard.usageBody')}</CardDescription>
            </CardHeader>
            <CardContent>
              {/* Read straight from `GET /users/me`; there is no separate stats
                  endpoint in the contract and none is invented here (R10). */}
              <dl className="grid gap-3 sm:grid-cols-2">
                <Well>
                  <dt className="text-[12px] font-semibold text-ink-muted">{t('dashboard.totalConversations')}</dt>
                  <dd className="std-no mt-1 text-2xl font-semibold text-ink">{user.conversationCount}</dd>
                </Well>
                <Well>
                  <dt className="text-[12px] font-semibold text-ink-muted">{t('dashboard.shownHere')}</dt>
                  <dd className="std-no mt-1 text-2xl font-semibold text-ink">{recent.length}</dd>
                </Well>
              </dl>
            </CardContent>
          </Card>
        </div>

        <aside className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>{t('dashboard.account')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-[13px]">
              <div>
                <p className="text-[11.5px] font-semibold text-ink-muted">{t('auth.emailLabel')}</p>
                <p className="std-no break-all text-ink">{user.email}</p>
              </div>
              <div>
                <p className="text-[11.5px] font-semibold text-ink-muted">{t('dashboard.roles')}</p>
                <p className="mt-1 flex flex-wrap gap-1">
                  {user.roles.map((role) => (
                    <Badge key={role} variant="neutral">
                      {role}
                    </Badge>
                  ))}
                </p>
              </div>
              {user.persona ? (
                <div>
                  <p className="text-[11.5px] font-semibold text-ink-muted">{t('auth.personaLabel')}</p>
                  <p className="text-ink">{t(`auth.personas.${user.persona}`)}</p>
                </div>
              ) : null}
              <div>
                <p className="text-[11.5px] font-semibold text-ink-muted">{t('dashboard.memberSince')}</p>
                <p className="text-ink">{formatDateTime(user.createdAt, i18n.language)}</p>
              </div>
              <div>
                <p className="text-[11.5px] font-semibold text-ink-muted">{t('auth.emailLabel')}</p>
                <Badge variant={user.emailVerified ? 'verified' : 'warn'}>
                  {user.emailVerified ? t('dashboard.emailVerified') : t('dashboard.emailUnverified')}
                </Badge>
              </div>
              <div className="border-t border-line pt-3">
                {/* The password-reset flow is reused for a signed-in user who wants
                    to rotate their password; it revokes every session on success. */}
                <Button variant="outline" size="sm" className="w-full" onClick={() => navigate('/forgot-password')}>
                  {t('auth.forgotPassword')}
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('dashboard.privacy')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-[12.5px] leading-5 text-ink-muted">
              <p>{t('dashboard.privacyBody')}</p>
              <InformationalLabel />
            </CardContent>
          </Card>

          {hasRole('CONTENT_MANAGER') ? (
            <Card className="border-teal">
              <CardHeader>
                <CardTitle>{t('nav.admin')}</CardTitle>
              </CardHeader>
              <CardContent>
                <Button asChild variant="teal" className="w-full">
                  <Link to="/admin">{t('nav.admin')}</Link>
                </Button>
              </CardContent>
            </Card>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------- admin */

/**
 * Admin surface (P1 shell).
 *
 * This page exists to prove role enforcement end-to-end: it calls three endpoints
 * at two different privilege levels and renders whatever the server actually
 * allows. CONTENT_MANAGER may read knowledge and ingestion state; only ADMIN may
 * read audit logs. The server rejects the other combination no matter what the UI
 * does — hiding a tab is never the control (§4).
 */
export function AdminPage() {
  const { t, i18n } = useTranslation();
  const { hasRole } = useSession();
  const isAdmin = hasRole('ADMIN');

  const statsQuery = useQuery({
    queryKey: ['admin', 'knowledge', 'stats'],
    queryFn: () => apiFetch<KnowledgeStatsResponse>('/admin/knowledge/stats'),
  });

  const jobsQuery = useQuery({
    queryKey: ['admin', 'ingestion', 'jobs'],
    queryFn: () => apiFetch<IngestionJobsResponse>('/admin/ingestion/jobs'),
  });

  const auditQuery = useQuery({
    queryKey: ['admin', 'audit-logs'],
    queryFn: () => apiFetch<AuditLogsResponse>('/admin/audit-logs'),
    enabled: isAdmin,
  });

  return (
    <div className="mx-auto w-full max-w-[64rem] px-4 py-10">
      <header>
        <h1 className="font-serif text-2xl font-semibold text-ink">{t('nav.admin')}</h1>
        <p className="mt-1 text-[13.5px] text-ink-muted">{t('admin.subtitle')}</p>
      </header>

      <div className="mt-6 space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>{t('admin.knowledgeStats')}</CardTitle>
            <CardDescription>{t('admin.knowledgeStatsBody')}</CardDescription>
          </CardHeader>
          <CardContent>
            {statsQuery.isLoading ? (
              <LoadingState label={t('common.loading')} rows={2} />
            ) : statsQuery.isError ? (
              <ErrorState
                title={t('states.errorTitle')}
                body={statsQuery.error instanceof ApiError ? statsQuery.error.message : undefined}
                onRetry={() => void statsQuery.refetch()}
                retryLabel={t('common.retry')}
              />
            ) : (
              <>
                <dl className="grid gap-3 sm:grid-cols-4">
                  <Stat label={t('admin.documents')} value={statsQuery.data?.documents ?? 0} />
                  <Stat label={t('admin.approvedChunks')} value={statsQuery.data?.chunks ?? 0} />
                  <Stat label={t('admin.ingestionJobs')} value={statsQuery.data?.jobs ?? 0} />
                  <Stat label={t('admin.kbVersion')} value={statsQuery.data?.kbVersion ?? 0} />
                </dl>
                {statsQuery.data ? (
                  <p className="mt-3 rounded-md border border-line bg-paper-sunken px-3 py-2 text-[12.5px] leading-5 text-ink-muted">
                    <span className="font-semibold text-ink">{t('admin.coverageDerivedFrom')}:</span>{' '}
                    {statsQuery.data.coverage.derivedFrom}. {statsQuery.data.coverage.note}
                  </p>
                ) : null}
                {(statsQuery.data?.chunks ?? 0) === 0 ? (
                  <p className="mt-3 rounded-md border border-warn bg-warn-soft px-3 py-2.5 text-[13px] leading-5 text-warn">
                    {t('landing.emptyKnowledgeNote')}
                  </p>
                ) : null}
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('admin.ingestionJobsTitle')}</CardTitle>
            <CardDescription>{t('admin.ingestionJobsBody')}</CardDescription>
          </CardHeader>
          <CardContent>
            {jobsQuery.isLoading ? (
              <LoadingState label={t('common.loading')} rows={2} />
            ) : jobsQuery.isError ? (
              <ErrorState
                title={t('states.errorTitle')}
                body={jobsQuery.error instanceof ApiError ? jobsQuery.error.message : undefined}
                onRetry={() => void jobsQuery.refetch()}
                retryLabel={t('common.retry')}
              />
            ) : (jobsQuery.data?.items.length ?? 0) === 0 ? (
              <EmptyState title={t('admin.noJobs')} body={t('admin.noJobsBody')} />
            ) : (
              <>
                {jobsQuery.data && jobsQuery.data.failed > 0 ? (
                  <p className="mb-3 rounded-md border border-error bg-error-soft px-3 py-2 text-[12.5px] font-semibold text-error">
                    {t('admin.failedJobs', { count: jobsQuery.data.failed })}
                  </p>
                ) : null}
                <ul className="divide-y divide-line">
                  {jobsQuery.data?.items.slice(0, 8).map((job) => (
                    <li key={job.id} className="flex flex-wrap items-center gap-2 py-2 text-[12.5px]">
                      <Badge variant={job.state === 'SUCCEEDED' ? 'verified' : job.state === 'FAILED' ? 'error' : 'neutral'}>
                        {job.state}
                      </Badge>
                      <span className="std-no text-ink-muted">{job.stage}</span>
                      <span className="std-no ml-auto text-ink-faint">{formatRelative(job.updatedAt, i18n.language)}</span>
                      {job.error ? <span className="w-full text-[11.5px] text-error">{job.error}</span> : null}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </CardContent>
        </Card>

        <Card className={cn(!isAdmin && 'opacity-70')}>
          <CardHeader>
            <CardTitle>{t('admin.auditLogs')}</CardTitle>
            <CardDescription>{isAdmin ? t('admin.auditLogsBody') : t('admin.auditLogsRestricted')}</CardDescription>
          </CardHeader>
          <CardContent>
            {!isAdmin ? (
              <EmptyState title={t('states.forbiddenTitle')} body={t('admin.auditLogsRestricted')} />
            ) : auditQuery.isLoading ? (
              <LoadingState label={t('common.loading')} rows={4} />
            ) : auditQuery.isError ? (
              <ErrorState
                title={t('states.errorTitle')}
                body={auditQuery.error instanceof ApiError ? auditQuery.error.message : undefined}
                onRetry={() => void auditQuery.refetch()}
                retryLabel={t('common.retry')}
              />
            ) : (auditQuery.data?.items.length ?? 0) === 0 ? (
              <EmptyState title={t('admin.noLogs')} />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[12.5px]">
                  <caption className="sr-only">{t('admin.auditLogs')}</caption>
                  <thead>
                    <tr className="border-b border-line text-[11px] font-semibold text-ink-muted">
                      <th scope="col" className="py-2 pr-3">{t('admin.colWhen')}</th>
                      <th scope="col" className="py-2 pr-3">{t('admin.colActor')}</th>
                      <th scope="col" className="py-2 pr-3">{t('admin.colAction')}</th>
                      <th scope="col" className="py-2 pr-3">{t('admin.colTarget')}</th>
                      <th scope="col" className="py-2">{t('admin.colOutcome')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditQuery.data?.items.map((row) => (
                      <tr key={row.id} className="border-b border-line/60 last:border-0">
                        <td className="py-2 pr-3 whitespace-nowrap text-ink-muted">
                          {formatRelative(row.createdAt, i18n.language)}
                        </td>
                        <td className="py-2 pr-3">
                          <span className="std-no block max-w-[12rem] truncate text-ink">{row.actorUserId ?? '—'}</span>
                          {row.actorRoles.length > 0 ? (
                            <span className="std-no block text-[10.5px] text-ink-faint">{row.actorRoles.join(', ')}</span>
                          ) : null}
                        </td>
                        <td className="std-no py-2 pr-3 whitespace-nowrap text-ink">{row.action}</td>
                        <td className="std-no py-2 pr-3 text-ink-muted">
                          {row.entityType ?? '—'}
                          {row.entityId ? <span className="text-ink-faint"> · {row.entityId}</span> : null}
                        </td>
                        <td className="py-2">
                          <Badge variant={row.outcome === 'SUCCESS' ? 'verified' : row.outcome === 'DENIED' ? 'error' : 'neutral'}>
                            {row.outcome}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Well>
      <dt className="text-[11.5px] font-semibold text-ink-muted">{label}</dt>
      <dd className="std-no mt-1 text-xl font-semibold text-ink">{value}</dd>
    </Well>
  );
}
