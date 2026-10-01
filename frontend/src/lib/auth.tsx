import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, bootstrapSession, clearSession, setAccessToken, ApiError } from './api';
import type { BootstrapResponse, Language, MeResponse, Persona, SessionResponse } from './types';
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, readCookie } from './utils';

/**
 * Session state.
 *
 * The access token is held in module memory by `api.ts` and mirrored here only as
 * a boolean, so a React devtools inspection or an XSS payload cannot read a usable
 * long-lived credential from this tree.
 *
 * `status` has three values, and the difference matters: `loading` (we have not
 * asked yet), `restoring` (a refresh cookie exists and may still be valid), and
 * `anonymous`/`authenticated`. Route guards must not redirect while `restoring`,
 * or a page reload would bounce a signed-in user to the login screen.
 */

export type SessionStatus = 'loading' | 'restoring' | 'authenticated' | 'anonymous';

export interface LoginInput {
  email: string;
  password: string;
}

export interface RegisterInput {
  email: string;
  password: string;
  fullName: string;
  persona?: Persona | null;
  language?: Language;
}

interface SessionContextValue {
  status: SessionStatus;
  user: MeResponse | null;
  bootstrap: BootstrapResponse | null;
  bootstrapError: ApiError | null;
  login: (input: LoginInput) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  logout: () => Promise<void>;
  updateProfile: (patch: { fullName?: string; persona?: Persona | null; language?: Language }) => Promise<void>;
  hasRole: (role: 'USER' | 'CONTENT_MANAGER' | 'ADMIN') => boolean;
}

const SessionContext = React.createContext<SessionContextValue | null>(null);

/** Role implication, mirroring ROLE_IMPLIES on the server (§4). Cosmetic only. */
const ROLE_IMPLIES: Record<string, string[]> = {
  USER: ['USER'],
  CONTENT_MANAGER: ['CONTENT_MANAGER', 'USER'],
  ADMIN: ['ADMIN', 'CONTENT_MANAGER', 'USER'],
};

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = React.useState<SessionStatus>('loading');

  const bootstrapQuery = useQuery({
    queryKey: ['meta', 'bootstrap'],
    queryFn: () => apiFetch<BootstrapResponse>('/meta/bootstrap'),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });

  const meQuery = useQuery({
    queryKey: ['users', 'me'],
    queryFn: () => apiFetch<MeResponse>('/users/me'),
    // Only meaningful once we know whether a session could be restored.
    enabled: status === 'authenticated',
    staleTime: 30 * 1000,
    retry: false,
  });

  /**
   * On first mount, try to exchange a surviving HttpOnly refresh cookie for an
   * access token. Failure is normal (first visit / logged out) and is not an error.
   */
  React.useEffect(() => {
    let cancelled = false;
    setStatus('restoring');
    void bootstrapSession().then((restored) => {
      if (cancelled) return;
      setStatus(restored ? 'authenticated' : 'anonymous');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // If /users/me fails with 401 the token is gone: fall back to anonymous rather
  // than showing a broken authenticated shell.
  React.useEffect(() => {
    if (meQuery.error instanceof ApiError && meQuery.error.status === 401 && status === 'authenticated') {
      clearSession();
      setStatus('anonymous');
    }
  }, [meQuery.error, status]);

  const applySession = React.useCallback(
    (session: SessionResponse) => {
      setAccessToken(session.accessToken);
      queryClient.setQueryData<MeResponse>(['users', 'me'], {
        ...session.user,
        locked: false,
        conversationCount: 0,
      });
      setStatus('authenticated');
    },
    [queryClient],
  );

  const loginMutation = useMutation({
    mutationFn: (input: LoginInput) => apiFetch<SessionResponse>('/auth/login', { method: 'POST', body: input }),
    onSuccess: applySession,
  });

  const registerMutation = useMutation({
    mutationFn: (input: RegisterInput) => apiFetch<SessionResponse>('/auth/register', { method: 'POST', body: input }),
    onSuccess: applySession,
  });

  const logoutMutation = useMutation({
    mutationFn: async () => {
      // Cookie-borne flow, so the CSRF header is required (docs/API.md).
      await apiFetch<void>('/auth/logout', { method: 'POST', csrf: true });
    },
    onSettled: () => {
      clearSession();
      queryClient.clear();
      setStatus('anonymous');
    },
  });

  const profileMutation = useMutation({
    mutationFn: (patch: { fullName?: string; persona?: Persona | null; language?: Language }) =>
      apiFetch<MeResponse>('/users/me', { method: 'PATCH', body: patch }),
    onSuccess: (data) => {
      queryClient.setQueryData(['users', 'me'], data);
    },
  });

  const value = React.useMemo<SessionContextValue>(
    () => ({
      status,
      user: meQuery.data ?? null,
      bootstrap: bootstrapQuery.data ?? null,
      bootstrapError: bootstrapQuery.error instanceof ApiError ? bootstrapQuery.error : null,
      login: async (input) => {
        await loginMutation.mutateAsync(input);
      },
      register: async (input) => {
        await registerMutation.mutateAsync(input);
      },
      logout: async () => {
        await logoutMutation.mutateAsync();
      },
      updateProfile: async (patch) => {
        await profileMutation.mutateAsync(patch);
      },
      hasRole: (role) => {
        const roles = meQuery.data?.roles ?? [];
        return roles.some((held) => (ROLE_IMPLIES[held] ?? [held]).includes(role));
      },
    }),
    [status, meQuery.data, bootstrapQuery.data, bootstrapQuery.error, loginMutation, registerMutation, logoutMutation, profileMutation],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = React.useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>');
  return ctx;
}

/** True when the UI must show the "mock provider" badge (R8/R10). */
export function useIsMockProvider(): boolean {
  const { bootstrap } = useSession();
  return bootstrap?.app.mockProvider ?? false;
}

export { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, readCookie };
