import * as React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useSession } from '@/lib/auth';
import type { Role } from '@/lib/types';
import { EmptyState, LoadingState } from '@/components/ui/states';

/**
 * Route guards.
 *
 * §4 is explicit that these are COSMETIC: every endpoint enforces roles and
 * ownership server-side, and the mock API/Spring backend both return 401/403/404
 * regardless of what the router does. These components exist so the UI does not
 * render a form that is guaranteed to fail.
 */

/** Preserves where the user was headed so login can send them back. */
export function useReturnTo(): string {
  const location = useLocation();
  const state = location.state as { from?: string } | null;
  const search = new URLSearchParams(location.search);
  return state?.from ?? search.get('next') ?? `${location.pathname}${location.search}`;
}

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { status } = useSession();
  const location = useLocation();
  const { t } = useTranslation();

  // Do NOT redirect while a refresh cookie is still being exchanged, or a page
  // reload would bounce a signed-in user to the login screen.
  if (status === 'loading' || status === 'restoring') {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-10">
        <LoadingState label={t('common.loading')} rows={4} />
      </div>
    );
  }

  if (status !== 'authenticated') {
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace state={{ from: next }} />;
  }

  return <>{children}</>;
}

export function RequireRole({ role, children }: { role: Role; children: React.ReactNode }) {
  const { status, hasRole } = useSession();
  const { t } = useTranslation();
  const location = useLocation();

  if (status === 'loading' || status === 'restoring') {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-10">
        <LoadingState label={t('common.loading')} rows={4} />
      </div>
    );
  }
  if (status !== 'authenticated') {
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace state={{ from: next }} />;
  }
  if (!hasRole(role)) {
    // Honest dead-end: no fake content, and a real way out.
    return (
      <EmptyState
        title={t('states.forbiddenTitle')}
        body={t('states.forbiddenBody')}
        className="mx-auto w-full max-w-md"
      />
    );
  }
  return <>{children}</>;
}

/** Sends an already-signed-in user away from login/register. */
export function RedirectIfAuthenticated({ to, children }: { to?: string; children: React.ReactNode }) {
  const { status } = useSession();
  const { t } = useTranslation();
  const returnTo = useReturnTo();

  if (status === 'loading' || status === 'restoring') {
    return (
      <div className="mx-auto w-full max-w-md px-4 py-10">
        <LoadingState label={t('common.loading')} rows={3} />
      </div>
    );
  }
  if (status === 'authenticated') {
    const fallback = to ?? '/chat';
    const target = returnTo && returnTo !== '/login' && returnTo !== '/register' ? returnTo : fallback;
    return <Navigate to={target} replace />;
  }
  return <>{children}</>;
}
