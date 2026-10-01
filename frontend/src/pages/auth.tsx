import * as React from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { buildAuthSchemas, EMAIL_MAX, NAME_MAX } from '@/lib/validation';
import { ApiError } from '@/lib/api';
import { useSession } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, Textarea } from '@/components/ui/textarea';
import { Field } from '@/components/ui/label';
import { ErrorState } from '@/components/ui/states';
import type { Persona } from '@/lib/types';

/**
 * Authentication pages (feature #1, P1).
 *
 * Client-side validation mirrors the server schema in docs/API.md exactly, so a
 * user is not sent a payload the API will reject. The server remains authoritative:
 * every rule here is also enforced there, and the tests assert both.
 */

/* --------------------------------------------------------------- validation */

/**
 * Built per-render so the messages are translated, and so the password minimum can
 * come from the server. `bootstrap.auth.passwordMinLength` is authoritative the
 * moment it arrives; the fallback covers only the first paint, and is the same
 * default the API documents.
 */
function useSchemas() {
  const { t } = useTranslation();
  const { bootstrap } = useSession();
  const passwordMinLength = bootstrap?.auth.passwordMinLength;
  return React.useMemo(
    () => buildAuthSchemas({ t, ...(passwordMinLength ? { passwordMinLength } : {}) }),
    [t, passwordMinLength],
  );
}

/* ------------------------------------------------------------------ helpers */

/** Maps a server error code to a translated, user-safe message. */
function useErrorTranslator() {
  const { t } = useTranslation();
  return React.useCallback(
    (error: unknown): string => {
      if (error instanceof ApiError) {
        switch (error.code) {
          case 'INVALID_CREDENTIALS':
            return t('auth.errors.invalidCredentials');
          case 'ACCOUNT_LOCKED':
            return t('auth.errors.accountLocked');
          case 'RATE_LIMITED':
            return t('auth.errors.rateLimited');
          case 'CONFLICT':
            return t('auth.errors.conflict');
          case 'CSRF_FAILED':
          case 'REFRESH_REUSED':
            return t('auth.errors.csrf');
          case 'NETWORK_ERROR':
            return t('auth.errors.network');
          case 'VALIDATION_FAILED':
            return error.details[0]?.issue ?? t('auth.errors.validation');
          default:
            return error.message || t('auth.errors.unknown');
        }
      }
      return t('auth.errors.unknown');
    },
    [t],
  );
}

function AuthCard({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-md px-4 py-10 sm:py-16">
      <div className="paper-card p-5 sm:p-6">
        <h1 className="font-serif text-xl font-semibold text-ink">{title}</h1>
        {subtitle ? <p className="mt-1.5 text-[13.5px] leading-5 text-ink-muted">{subtitle}</p> : null}
        <div className="mt-5">{children}</div>
      </div>
      {footer ? <div className="mt-4 text-center text-[13px] text-ink-muted">{footer}</div> : null}
    </div>
  );
}

function PasswordInput({
  id,
  label,
  hint,
  error,
  required,
  autoComplete,
  register,
  placeholder,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  autoComplete: string;
  register: Record<string, unknown>;
  placeholder?: string;
}) {
  const { t } = useTranslation();
  const [visible, setVisible] = React.useState(false);
  const toggleId = `${id}-toggle`;
  return (
    <Field label={label} htmlFor={id} hint={hint} error={error} required={required}>
      {(props) => (
        <div className="relative">
          <Input
            {...props}
            {...register}
            type={visible ? 'text' : 'password'}
            autoComplete={autoComplete}
            placeholder={placeholder}
            invalid={Boolean(error)}
            className="pr-16"
          />
          <button
            id={toggleId}
            type="button"
            onClick={() => setVisible((v) => !v)}
            aria-pressed={visible}
            aria-controls={id}
            className="absolute top-1/2 right-2 -translate-y-1/2 rounded-sm px-2 py-1 text-[11.5px] font-semibold text-teal transition-colors duration-150 ease-out hover:bg-teal-soft focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-teal"
          >
            {visible ? t('auth.hidePassword') : t('auth.showPassword')}
          </button>
        </div>
      )}
    </Field>
  );
}

/* -------------------------------------------------------------------- login */

export function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { login, bootstrap } = useSession();
  const schemas = useSchemas();
  const translate = useErrorTranslator();
  const [formError, setFormError] = React.useState<string | null>(null);

  const next = params.get('next') ?? '/chat';

  const form = useForm<z.infer<ReturnType<typeof useSchemas>['login']>>({
    resolver: zodResolver(schemas.login),
    defaultValues: { email: '', password: '' },
    mode: 'onBlur',
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setFormError(null);
    try {
      await login(values);
      navigate(next, { replace: true });
    } catch (error) {
      const message = translate(error);
      setFormError(message);
    }
  });

  return (
    <AuthCard
      title={t('auth.loginTitle')}
      subtitle={t('auth.loginSubtitle')}
      footer={
        <>
          {t('auth.noAccount')}{' '}
          <Link to="/register" className="font-semibold text-teal underline-offset-4 hover:underline">
            {t('auth.registerLink')}
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {formError ? <ErrorState title={formError} /> : null}

        <Field label={t('auth.emailLabel')} htmlFor="login-email" error={form.formState.errors.email?.message} required>
          {(props) => (
            <Input
              {...props}
              {...form.register('email')}
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder={t('auth.emailPlaceholder')}
              invalid={Boolean(form.formState.errors.email)}
            />
          )}
        </Field>

        <PasswordInput
          id="login-password"
          label={t('auth.passwordLabel')}
          error={form.formState.errors.password?.message}
          autoComplete="current-password"
          register={form.register('password')}
          required
          placeholder={t('auth.passwordPlaceholder')}
        />

        <div className="flex items-center justify-between gap-2">
          <Link to="/forgot-password" className="text-[13px] font-medium text-teal underline-offset-4 hover:underline">
            {t('auth.forgotPassword')}
          </Link>
        </div>

        <Button type="submit" size="lg" className="w-full" busy={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? t('auth.submitting') : t('auth.submitLogin')}
        </Button>

        {bootstrap?.app.mockProvider ? (
          <p className="rounded-md border border-warn bg-warn-soft px-3 py-2 text-[12.5px] leading-4 text-warn">
            <span className="font-semibold">{t('auth.demoNoticeTitle')}.</span> {t('auth.demoNoticeBody')}
          </p>
        ) : null}
      </form>
    </AuthCard>
  );
}

/* ----------------------------------------------------------------- register */

export function RegisterPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { register: doRegister, bootstrap } = useSession();
  const schemas = useSchemas();
  const translate = useErrorTranslator();
  const [formError, setFormError] = React.useState<string | null>(null);

  const next = params.get('next') ?? '/chat';
  const personas = (bootstrap?.auth.personas ?? ['CONSUMER', 'MSME_MANUFACTURER', 'JEWELLER_RETAILER', 'STUDENT_ENGINEER']) as Persona[];

  const form = useForm<z.infer<ReturnType<typeof useSchemas>['register']>>({
    resolver: zodResolver(schemas.register),
    defaultValues: { fullName: '', email: '', password: '', confirmPassword: '', persona: '' },
    mode: 'onBlur',
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setFormError(null);
    try {
      await doRegister({
        email: values.email,
        password: values.password,
        fullName: values.fullName,
        persona: values.persona ? (values.persona as Persona) : null,
      });
      navigate(next, { replace: true });
    } catch (error) {
      // Bind the message to the offending control when the server named one, so it
      // is announced once, next to the field — not duplicated as a banner.
      const emailIssue = error instanceof ApiError ? error.fieldIssue('email') : undefined;
      if (emailIssue) form.setError('email', { message: emailIssue });
      else setFormError(translate(error));
    }
  });

  const errors = form.formState.errors;

  return (
    <AuthCard
      title={t('auth.registerTitle')}
      subtitle={t('auth.registerSubtitle')}
      footer={
        <>
          {t('auth.haveAccount')}{' '}
          <Link to="/login" className="font-semibold text-teal underline-offset-4 hover:underline">
            {t('auth.loginLink')}
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {formError ? <ErrorState title={formError} /> : null}

        <Field label={t('auth.fullNameLabel')} htmlFor="register-name" error={errors.fullName?.message} required>
          {(props) => (
            <Input
              {...props}
              {...form.register('fullName')}
              autoComplete="name"
              maxLength={NAME_MAX}
              placeholder={t('auth.fullNamePlaceholder')}
              invalid={Boolean(errors.fullName)}
            />
          )}
        </Field>

        <Field label={t('auth.emailLabel')} htmlFor="register-email" error={errors.email?.message} required>
          {(props) => (
            <Input
              {...props}
              {...form.register('email')}
              type="email"
              inputMode="email"
              autoComplete="email"
              maxLength={EMAIL_MAX}
              placeholder={t('auth.emailPlaceholder')}
              invalid={Boolean(errors.email)}
            />
          )}
        </Field>

        <PasswordInput
          id="register-password"
          label={t('auth.passwordLabel')}
          hint={t('auth.passwordHint')}
          error={errors.password?.message}
          autoComplete="new-password"
          register={form.register('password')}
          required
        />

        <PasswordInput
          id="register-confirm"
          label={t('auth.confirmPasswordLabel')}
          error={errors.confirmPassword?.message}
          autoComplete="new-password"
          register={form.register('confirmPassword')}
          required
        />

        {/* Persona is a profile field, never a permission (§1). */}
        <Field label={t('auth.personaLabel')} htmlFor="register-persona" hint={t('common.optional')}>
          {(props) => (
            <Select {...props} {...form.register('persona')} placeholder={t('auth.personaPlaceholder')}>
              {personas.map((persona) => (
                <option key={persona} value={persona}>
                  {t(`auth.personas.${persona}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Button type="submit" size="lg" className="w-full" busy={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? t('auth.submitting') : t('auth.submitRegister')}
        </Button>
      </form>
    </AuthCard>
  );
}

/* ---------------------------------------------------------- forgot password */

export function ForgotPasswordPage() {
  const { t } = useTranslation();
  const schemas = useSchemas();
  const translate = useErrorTranslator();
  const [formError, setFormError] = React.useState<string | null>(null);
  const [sent, setSent] = React.useState(false);
  // The dev-only token is surfaced so the flow can actually be completed without
  // an email provider. It is never returned by a production server.
  const [devToken, setDevToken] = React.useState<string | null>(null);

  const form = useForm<z.infer<ReturnType<typeof useSchemas>['forgot']>>({
    resolver: zodResolver(schemas.forgot),
    defaultValues: { email: '' },
    mode: 'onBlur',
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setFormError(null);
    try {
      const res = await fetch('/api/v1/auth/password/reset-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'include',
        body: JSON.stringify(values),
      });
      if (!res.ok) throw await ApiErrorFromResponse(res);
      const data = (await res.json()) as { devToken?: string };
      setSent(true);
      setDevToken(data.devToken ?? null);
    } catch (error) {
      setFormError(translate(error));
    }
  });

  if (sent) {
    return (
      <AuthCard title={t('auth.forgotSentTitle')} subtitle={t('auth.forgotSentBody')}>
        <div className="space-y-3">
          {devToken ? (
            <div className="rounded-md border border-warn bg-warn-soft px-3 py-2.5">
              <p className="text-[12.5px] font-semibold text-warn">Development mode — no email provider configured</p>
              <Textarea readOnly value={devToken} rows={2} className="std-no mt-1.5 text-[11.5px]" aria-label="Reset token" />
              <Button asChild size="sm" variant="secondary" className="mt-2">
                <Link to={`/reset-password?token=${encodeURIComponent(devToken)}`}>{t('auth.resetTitle')}</Link>
              </Button>
            </div>
          ) : null}
          <Button asChild variant="secondary" className="w-full">
            <Link to="/login">{t('auth.loginLink')}</Link>
          </Button>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title={t('auth.forgotTitle')}
      subtitle={t('auth.forgotBody')}
      footer={
        <Link to="/login" className="font-semibold text-teal underline-offset-4 hover:underline">
          {t('auth.loginLink')}
        </Link>
      }
    >
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {formError ? <ErrorState title={formError} /> : null}
        <Field label={t('auth.emailLabel')} htmlFor="forgot-email" error={form.formState.errors.email?.message} required>
          {(props) => (
            <Input
              {...props}
              {...form.register('email')}
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder={t('auth.emailPlaceholder')}
              invalid={Boolean(form.formState.errors.email)}
            />
          )}
        </Field>
        <Button type="submit" size="lg" className="w-full" busy={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? t('auth.submitting') : t('auth.forgotSubmit')}
        </Button>
      </form>
    </AuthCard>
  );
}

async function ApiErrorFromResponse(res: Response): Promise<ApiError> {
  let body: { error?: { code: string; message: string; details?: Array<{ field: string; issue: string }>; traceRef: string } } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    body = {};
  }
  return new ApiError(
    res.status,
    body.error ? { ...body.error, traceRef: body.error.traceRef ?? '' } : null,
    `Request failed with ${res.status}`,
  );
}

/* ----------------------------------------------------------- reset password */

export function ResetPasswordPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const schemas = useSchemas();
  const translate = useErrorTranslator();
  const [formError, setFormError] = React.useState<string | null>(null);
  const token = params.get('token') ?? '';

  const form = useForm<z.infer<ReturnType<typeof useSchemas>['reset']>>({
    resolver: zodResolver(schemas.reset),
    defaultValues: { token, password: '' },
    mode: 'onBlur',
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setFormError(null);
    try {
      const res = await fetch('/api/v1/auth/password/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(values),
      });
      if (!res.ok && res.status !== 204) throw await ApiErrorFromResponse(res);
      navigate('/login?reset=done', { replace: true });
    } catch (error) {
      setFormError(translate(error));
    }
  });

  if (!token) {
    return (
      <AuthCard title={t('auth.resetTitle')}>
        <ErrorState
          title={t('auth.errors.unknown')}
          body={t('auth.forgotBody')}
          retryLabel={t('auth.forgotTitle')}
          onRetry={() => navigate('/forgot-password')}
        />
      </AuthCard>
    );
  }

  return (
    <AuthCard title={t('auth.resetTitle')}>
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {formError ? <ErrorState title={formError} /> : null}
        <PasswordInput
          id="reset-password"
          label={t('auth.passwordLabel')}
          hint={t('auth.passwordHint')}
          error={form.formState.errors.password?.message}
          autoComplete="new-password"
          register={form.register('password')}
          required
        />
        <input type="hidden" {...form.register('token')} />
        <Button type="submit" size="lg" className="w-full" busy={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? t('auth.submitting') : t('auth.resetSubmit')}
        </Button>
      </form>
    </AuthCard>
  );
}
