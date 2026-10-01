import * as React from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useSession } from '@/lib/auth';
import { LanguageSwitch } from '@/components/language-switch';
import { MockProviderBadge } from '@/components/mock-badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { messageEnter, transitionBase } from '@/lib/motion';

/**
 * Application shell: masthead, primary navigation, and the routed page.
 *
 * The masthead carries the trust signal permanently — the app name, the "sources you
 * can check" framing, and the mock-provider badge when one applies — because §11
 * wants an evidence-first identity, not a chrome-free canvas.
 */

function Mark() {
  // A printed-standard mark: a ruled block, no gradient, no decoration.
  return (
    <span
      aria-hidden="true"
      className="flex size-8 shrink-0 items-center justify-center rounded-sm border border-saffron bg-navy"
    >
      <svg viewBox="0 0 20 20" className="size-4 text-paper-raised" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M4 4.5h12M4 8h12M4 11.5h8M4 15h5" strokeLinecap="round" />
      </svg>
    </span>
  );
}

function NavItem({ to, children, end }: { to: string; children: React.ReactNode; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          'rounded-sm px-2.5 py-1.5 text-[13.5px] font-medium transition-colors duration-150 ease-out',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-paper-raised',
          isActive ? 'bg-navy-hover text-paper-raised' : 'text-paper-raised/75 hover:bg-navy-hover/60 hover:text-paper-raised',
        )
      }
    >
      {children}
    </NavLink>
  );
}

export function AppShell() {
  const { t } = useTranslation();
  const { status, user, logout, hasRole } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const reduceMotion = useReducedMotion();
  const [loggingOut, setLoggingOut] = React.useState(false);

  const authenticated = status === 'authenticated';

  const onLogout = async () => {
    setLoggingOut(true);
    // Navigate away from any protected route BEFORE the session state flips,
    // otherwise the route guard re-renders first and bounces the user through
    // /login?next=… on the way out. The session is cleared locally in the
    // mutation's onSettled, so this is correct whether or not the API call lands.
    navigate('/', { replace: true });
    try {
      await logout();
    } finally {
      setLoggingOut(false);
    }
  };

  return (
    <div className="flex min-h-full flex-col bg-paper">
      <a href="#main" className="skip-link">
        {t('common.skipToContent')}
      </a>

      <header className="sticky top-0 z-40 border-b border-navy bg-navy text-paper-raised">
        <div className="mx-auto flex h-14 w-full max-w-[100rem] items-center gap-3 px-4">
          <Link
            to="/"
            className="flex min-w-0 items-center gap-2.5 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-paper-raised"
          >
            <Mark />
            <span className="min-w-0">
              <span className="block truncate font-serif text-[17px] leading-5 font-semibold">
                {t('common.appName')}
              </span>
              <span className="hidden truncate text-[11.5px] leading-4 text-paper-raised/70 sm:block">
                {t('common.tagline')}
              </span>
            </span>
          </Link>

          <nav aria-label={t('nav.chat')} className="ml-2 hidden items-center gap-1 md:flex">
            <NavItem to="/" end>
              {t('nav.home')}
            </NavItem>
            {authenticated ? <NavItem to="/chat">{t('nav.chat')}</NavItem> : null}
            {authenticated && hasRole('CONTENT_MANAGER') ? <NavItem to="/admin">{t('nav.admin')}</NavItem> : null}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <MockProviderBadge className="hidden sm:inline-flex" />
            <LanguageSwitch />

            {authenticated && user ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-paper-raised hover:bg-navy-hover hover:text-paper-raised"
                  >
                    <span className="max-w-[9rem] truncate">{user.fullName}</span>
                    <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                      <path d="M4 6.5 8 10.5 12 6.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="text-ink">
                  <DropdownMenuLabel>{user.email}</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => navigate('/chat')}>{t('nav.chat')}</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => navigate('/dashboard')}>{t('nav.dashboard')}</DropdownMenuItem>
                  {hasRole('CONTENT_MANAGER') ? (
                    <DropdownMenuItem onSelect={() => navigate('/admin')}>{t('nav.admin')}</DropdownMenuItem>
                  ) : null}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem destructive disabled={loggingOut} onSelect={() => void onLogout()}>
                    {loggingOut ? t('auth.submitting') : t('nav.signOut')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <div className="flex items-center gap-1.5">
                <Button
                  asChild
                  variant="ghost"
                  size="sm"
                  className="text-paper-raised hover:bg-navy-hover hover:text-paper-raised"
                >
                  <Link to="/login">{t('nav.signIn')}</Link>
                </Button>
                <Button asChild variant="teal" size="sm">
                  <Link to="/register">{t('nav.register')}</Link>
                </Button>
              </div>
            )}
          </div>
        </div>
      </header>

      <main id="main" className="flex-1">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={location.pathname}
            initial={reduceMotion ? false : 'initial'}
            animate={reduceMotion ? undefined : 'animate'}
            exit={reduceMotion ? undefined : 'exit'}
            variants={reduceMotion ? undefined : messageEnter}
            transition={reduceMotion ? { duration: 0 } : transitionBase}
            className="h-full"
          >
            <Outlet />
          </motion.div>
        </AnimatePresence>
      </main>

      <footer className="border-t border-line bg-paper-raised">
        <div className="mx-auto flex w-full max-w-[100rem] flex-col gap-2 px-4 py-5 text-[12.5px] leading-5 text-ink-muted">
          <p className="font-medium text-ink">{t('common.disclaimer')}</p>
          <p>{t('footer.notAffiliated')}</p>
          <p>{t('footer.builtNote')}</p>
        </div>
      </footer>
    </div>
  );
}
