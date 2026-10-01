import { randomBytes } from 'node:crypto';
import { config } from '../config';
import { logger } from './logger';

/**
 * Outbound mail (P2).
 *
 * The only message this app sends today is the password-reset link — see
 * `docs/SECURITY.md` §7 for why there is no welcome mail and no analytics mail.
 *
 * Three transports, chosen by `MAIL_TRANSPORT`:
 *   smtp — real delivery via nodemailer. Requires a host or a connection URL.
 *   log  — development/test only. Prints the message so a local run can complete
 *          the flow, and refuses to run in production (asserted in `config.ts`).
 *   none — no transport is configured. `send()` returns `sent: false`, and the
 *          caller must not claim a mail went out (R8).
 *
 * The reset token never enters the structured log: `logger` would redact a key
 * shaped like a secret, which is fine, but a *link* containing it must also never
 * be logged in production. Only the `log` transport prints a link, and the config
 * validator keeps that transport out of production.
 */

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface SendResult {
  sent: boolean;
  transport: 'smtp' | 'log' | 'none';
  /** Provider message id when available, otherwise a short human-readable status. */
  detail: string;
}

export interface Mailer {
  readonly transport: 'smtp' | 'log' | 'none';
  /** True when this transport can actually deliver a message to a mailbox. */
  readonly canDeliver: boolean;
  send(mail: OutgoingMail): Promise<SendResult>;
}

/**
 * Lazily-created nodemailer transport. Kept behind a function so that a stack
 * running with `MAIL_TRANSPORT=log` never loads the SMTP code path at all, and so
 * a misconfigured SMTP URL is reported on first use instead of at import time.
 */
type SmtpSender = (mail: OutgoingMail) => Promise<{ messageId?: string }>;

let smtpSender: SmtpSender | null = null;

async function createSmtpSender(): Promise<SmtpSender> {
  const c = config();
  const nodemailer = await import('nodemailer');
  const options = c.SMTP_URL
    ? { url: c.SMTP_URL }
    : {
        host: c.SMTP_HOST,
        port: c.SMTP_PORT,
        secure: c.SMTP_SECURE,
        // STARTTLS is nodemailer's default on 587; we never disable it, so a
        // credential never travels in cleartext to a host that supports TLS.
        ...(c.SMTP_USER && c.SMTP_PASS
          ? { auth: { user: c.SMTP_USER, pass: c.SMTP_PASS } }
          : {}),
      };
  const transport = nodemailer.createTransport({
    ...options,
    pool: true,
    maxConnections: 3,
    tls: { minVersion: 'TLSv1.2' },
  });
  const from = c.SMTP_FROM ?? c.SMTP_USER;
  if (!from) throw new Error('SMTP_FROM (or SMTP_USER) is required when MAIL_TRANSPORT=smtp');

  return async (mail) => {
    const info = await transport.sendMail({
      from,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      ...(mail.html ? { html: mail.html } : {}),
      // A reply address keeps a bounced reset from landing in a shared inbox.
      replyTo: from,
      headers: { 'X-Entity-Ref': `bs-${randomBytes(6).toString('hex')}` },
    });
    return { messageId: typeof info.messageId === 'string' ? info.messageId : undefined };
  };
}

export class SmtpMailer implements Mailer {
  readonly transport = 'smtp' as const;
  readonly canDeliver = true;

  async send(mail: OutgoingMail): Promise<SendResult> {
    try {
      smtpSender ??= await createSmtpSender();
      const info = await smtpSender(mail);
      return { sent: true, transport: 'smtp', detail: info.messageId ?? 'accepted by SMTP server' };
    } catch (err) {
      // The SMTP error text can contain the host and the username. Neither belongs
      // in an API response, so only a generic line is returned to the caller.
      logger.error('smtp send failed', { error: err instanceof Error ? err.message : String(err) });
      throw new Error('Mail delivery failed');
    }
  }
}

export class LogMailer implements Mailer {
  readonly transport = 'log' as const;
  readonly canDeliver = false;

  async send(mail: OutgoingMail): Promise<SendResult> {
    const banner = mail.text
      .split('\n')
      .map((l) => `│  ${l}`)
      .join('\n');
    process.stdout.write(
      `\n┌─ MAIL (MAIL_TRANSPORT=log — NOT delivered to a mailbox) ──────────────┐\n` +
        `│  to: ${mail.to}\n│  subject: ${mail.subject}\n${banner}\n` +
        `└───────────────────────────────────────────────────────────────────────┘\n\n`,
    );
    return { sent: false, transport: 'log', detail: 'printed to stdout; no SMTP transport configured' };
  }
}

export class NullMailer implements Mailer {
  readonly transport = 'none' as const;
  readonly canDeliver = false;

  async send(_mail: OutgoingMail): Promise<SendResult> {
    logger.warn('mail requested but MAIL_TRANSPORT=none', { to: _mail.to, subject: _mail.subject });
    return { sent: false, transport: 'none', detail: 'no mail transport configured' };
  }
}

let mailer: Mailer | null = null;

export function getMailer(): Mailer {
  if (mailer) return mailer;
  const c = config();
  if (c.isTest) {
    // Never the log transport in tests: it prints message bodies, and a reset link
    // in CI output is a leaked credential regardless of the environment it came from.
    // A test that cares about mail installs a capture transport explicitly.
    mailer = new NullMailer();
    return mailer;
  }
  mailer =
    c.MAIL_TRANSPORT === 'smtp' ? new SmtpMailer() : c.MAIL_TRANSPORT === 'log' ? new LogMailer() : new NullMailer();
  return mailer;
}

/** Test seam only: outside `NODE_ENV=test` this throws, so no production path can swap the transport. */
export function setMailerForTests(next: Mailer | null): void {
  if (!config().isTest) {
    throw new Error('setMailerForTests is only available when NODE_ENV=test');
  }
  mailer = next;
}

/* --------------------------------------------------------------- messages */

export interface PasswordResetMailInput {
  language: 'en' | 'hi';
  /** Raw single-use token. It is embedded in `resetUrl` or shown alone, never logged. */
  token: string;
  expiresMinutes: number;
  name: string;
}

/**
 * Builds the reset message. The link is included only when `APP_PUBLIC_URL` is
 * configured; otherwise the body asks the user to paste the token, because an
 * absolute link built from a request `Host` header is a header-injection and
 * password-reset-phishing vector.
 */
export function passwordResetMail(input: PasswordResetMailInput): OutgoingMail {
  const c = config();
  const base = c.APP_PUBLIC_URL;
  const link = base ? `${base}/reset-password?token=${encodeURIComponent(input.token)}` : null;
  const subject = `${c.MAIL_SUBJECT_PREFIX} ${
    input.language === 'hi' ? 'पासवर्ड रीसेट अनुरोध' : 'password reset request'
  }`;

  const lines =
    input.language === 'hi'
      ? [
          `नमस्ते ${input.name},`,
          '',
          'आपके BIS-Saathi खाते के लिए पासवर्ड रीसेट अनुरोध मिला है।',
          link ? `लींक: ${link}` : `रीसेट कोड: ${input.token}`,
          `यह कोड ${input.expiresMinutes} मिनट में समाप्त हो जाएगा और केवल एक बार उपयोग किया जा सकता है।`,
          '',
          'यदि आपने यह अनुरोध नहीं किया, तो कोई कार्रवाई करने की आवश्यकता नहीं है — आपका पासवर्ड नहीं बदला गया है।',
          '',
          'BIS-Saathi सूचनात्मक सहायक है; यह कोई आधिकारिक BIS पत्राचार नहीं है।',
        ]
      : [
          `Hello ${input.name},`,
          '',
          'A password reset was requested for your BIS-Saathi account.',
          link ? `Open this link to choose a new password:` : `Use this reset code:`,
          link ? link : input.token,
          `The code expires after ${input.expiresMinutes} minutes and can be used once.`,
          '',
          'If you did not request this, no action is needed — your password has not been changed.',
          '',
          'BIS-Saathi is an informational assistant; this is not official BIS correspondence.',
        ];

  const text = lines.filter((l, i, arr) => !(l === '' && arr[i - 1] === '')).join('\n');

  return {
    to: '', // filled by the caller, which is the only place that knows the account email
    subject,
    text,
    html: `<p>${input.language === 'hi' ? 'पासवर्ड रीसेट के लिए नीचे दिया गया बटन/लींक उपयोग करें।' : 'Use the link below to choose a new password.'}</p>${
      link ? `<p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>` : `<p><code>${escapeHtml(input.token)}</code></p>`
    }<p>${
      input.language === 'hi'
        ? `यह कोड ${input.expiresMinutes} मिनट में समाप्त होगा।`
        : `This code expires after ${input.expiresMinutes} minutes.`
    }</p>`,
  };
}

/** Minimal escaping for the HTML alternative part of the message. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
