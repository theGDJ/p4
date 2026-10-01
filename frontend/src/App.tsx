import { Route, Routes, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useSession } from '@/lib/auth';
import { AppShell } from '@/components/app-shell';
import { RequireAuth, RequireRole, RedirectIfAuthenticated } from '@/routes/guards';
import { LandingPage } from '@/pages/landing';
import { LoginPage, RegisterPage, ForgotPasswordPage, ResetPasswordPage } from '@/pages/auth';
import { ChatPage } from '@/pages/chat';
import { DashboardPage, AdminPage, NotFoundPage, BootScreen } from '@/pages/misc';

/**
 * Route table.
 *
 * Every guard here is cosmetic. The server re-checks the role on every request and
 * scopes every user-data query by user_id (§8, R9); these guards only decide what
 * UI to render.
 */
export function App() {
  const { status } = useSession();
  const location = useLocation();
  const { t } = useTranslation();

  // While the refresh cookie is being exchanged we do not know if the user is
  // signed in. Rendering the guard now would bounce a signed-in user to /login
  // and then back, so hold a splash until the session resolves.
  if (status === 'restoring' || status === 'loading') {
    return <BootScreen label={t('common.loading')} />;
  }

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<LandingPage />} />

        <Route
          path="login"
          element={
            <RedirectIfAuthenticated to="/chat">
              <LoginPage />
            </RedirectIfAuthenticated>
          }
        />
        <Route
          path="register"
          element={
            <RedirectIfAuthenticated to="/chat">
              <RegisterPage />
            </RedirectIfAuthenticated>
          }
        />
        <Route path="forgot-password" element={<ForgotPasswordPage />} />
        <Route path="reset-password" element={<ResetPasswordPage />} />

        <Route
          path="chat"
          element={
            <RequireAuth>
              <ChatPage />
            </RequireAuth>
          }
        />
        <Route
          path="chat/:conversationId"
          element={
            <RequireAuth>
              <ChatPage />
            </RequireAuth>
          }
        />
        <Route
          path="dashboard"
          element={
            <RequireAuth>
              <DashboardPage />
            </RequireAuth>
          }
        />
        <Route
          path="admin"
          element={
            <RequireRole role="CONTENT_MANAGER">
              <AdminPage />
            </RequireRole>
          }
        />

        <Route path="*" element={<NotFoundPage path={location.pathname} />} />
      </Route>
    </Routes>
  );
}
