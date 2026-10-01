import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { DOC_TYPES } from '../constants';
import { badRequest } from './errors';

/**
 * Input validation (§8). Schemas encode the limits published in docs/API.md.
 * Failures return 400 with per-field detail and nothing else — no stack, no echo
 * of the rejected value beyond the field path.
 */

/** Strip C0/C1 control characters and zero-width joiners used to smuggle text (R6). */
export function stripControlChars(input: string): string {
  return input
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, '');
}

export const emailSchema = z.email().max(254).transform((v) => v.trim().toLowerCase());

export const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters.')
  .max(200, 'Password is too long.')
  // Unicode property classes, not [A-Za-z] / \d: the backend checks
  // Character.isLetter / isDigit, and an ASCII-only class would reject a legal
  // Devanagari passphrase here while accepting it there. `u` is required for \p{...}.
  .refine((v) => /\p{L}/u.test(v), 'Include at least one letter.')
  .refine((v) => /\p{N}/u.test(v), 'Include at least one digit.');

export const fullNameSchema = z
  .string()
  .transform(stripControlChars)
  .pipe(z.string().trim().min(1, 'Enter your name.').max(120, 'Name is too long.'));

export const languageSchema = z.enum(['en', 'hi']);
export const personaSchema = z.enum(['CONSUMER', 'MSME_MANUFACTURER', 'JEWELLER_RETAILER', 'STUDENT_ENGINEER']);

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  fullName: fullNameSchema,
  persona: personaSchema.nullish(),
  language: languageSchema.default('en'),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password.').max(200),
});

export const resetRequestSchema = z.object({ email: emailSchema });

export const resetConfirmSchema = z.object({
  token: z.string().min(20, 'Invalid reset link.').max(200),
  password: passwordSchema,
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: passwordSchema,
});

export const patchMeSchema = z
  .object({
    // `role`, `roles`, `emailVerified` and `id` are intentionally absent: a client
    // cannot escalate by posting them. Unknown keys are stripped, not errored.
    fullName: fullNameSchema.optional(),
    persona: personaSchema.nullish(),
    language: languageSchema.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update.' });

export const createConversationSchema = z.object({
  title: z.string().trim().max(160).optional(),
  language: languageSchema.default('en'),
});

export const renameConversationSchema = z.object({
  title: z.string().trim().min(1, 'Title cannot be empty.').max(160),
});

export const sendMessageSchema = z.object({
  content: z
    .string()
    .transform(stripControlChars)
    .pipe(z.string().trim().min(1, 'Type a question.').max(4000, 'Questions are limited to 4000 characters.')),
  language: languageSchema.optional(),
});

/* --------------------------------------------------- P2: knowledge admin */

/** §5/§7 controlled vocabulary — a free-text doc_type would make the retrieval filter unenforceable. */
export const docTypeSchema = z.enum(DOC_TYPES);
export const copyrightSchema = z.enum(['PUBLIC', 'GOVERNMENT', 'LICENSED', 'RESTRICTED', 'UNKNOWN']);

/**
 * A standard number must contain a digit. That is not a style rule: a row whose
 * `standard_no` is prose would put a fabricated identifier in front of a user as
 * if it were a citation (R10).
 */
const standardNoSchema = z
  .string()
  .transform(stripControlChars)
  .pipe(
    z
      .string()
      .trim()
      .min(2, 'A standard number needs a digit, e.g. IS 10500:2012.')
      .max(64)
      .regex(/\d/, 'A standard number needs a digit, e.g. IS 10500:2012.'),
  );

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.')
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'Not a real date.')
  .refine((v) => Date.parse(`${v}T00:00:00Z`) <= Date.now(), 'A publication date cannot be in the future.');

/** Shared descriptive metadata for every ingestion route. */
const ingestMeta = {
  title: z.string().transform(stripControlChars).pipe(z.string().trim().min(3, 'A title is required for a citation.').max(200)),
  docType: docTypeSchema.default('STANDARD'),
  language: languageSchema.default('en'),
  standardNo: standardNoSchema.optional(),
  publisher: z.string().transform(stripControlChars).pipe(z.string().trim().max(255)).optional(),
  licenseNote: z.string().transform(stripControlChars).pipe(z.string().trim().max(1000)).optional(),
  copyrightStatus: copyrightSchema.optional(),
  accessLevel: z.enum(['open', 'restricted']).default('open'),
  publishedDate: isoDateSchema.optional(),
  revisedDate: isoDateSchema.optional(),
  documentId: z.uuid().optional(),
  /**
   * Admit text that the injection detector flagged. The flags stay recorded on every
   * chunk and remain visible to the reviewer, so this only lets text reach the review
   * queue — it never publishes anything, and it never rewrites the text (R4/R7).
   */
  overrideInjectionFlags: z.boolean().default(false),
  /**
   * Re-ingest even when an existing version has the identical content hash. Without it
   * a duplicate is a DONE job with zero chunks and an "unchanged" warning, which is the
   * right answer most of the time (R2: a re-ingest must not rewrite frozen evidence).
   */
  force: z.boolean().default(false),
};

/**
 * `.refine` rather than a second schema: the pair is only reachable through these
 * routes, and the error message can then name the actual conflict.
 */
function requireLicenceForRestricted<T extends { accessLevel: string; licenseNote?: string | undefined }>(value: T): boolean {
  return value.accessLevel !== 'restricted' || (value.licenseNote?.trim().length ?? 0) > 0;
}

export const ingestUrlSchema = z
  .object({
    url: z.url({ error: 'A full http(s) URL is required. Never invent one (see knowledge/README.md).' }).max(2048),
    ...ingestMeta,
  })
  .strict()
  .refine(requireLicenceForRestricted, {
    path: ['licenseNote'],
    message: 'A restricted source must state its licence terms before it can be recorded (R11).',
  });

export const ingestTextSchema = z
  .object({
    content: z
      .string()
      .transform(stripControlChars)
      .pipe(z.string().trim().min(40, 'Paste at least a paragraph; a fragment is not a knowledge source.')),
    ...ingestMeta,
  })
  .strict()
  .refine(requireLicenceForRestricted, {
    path: ['licenseNote'],
    message: 'A restricted source must state its licence terms before it can be recorded (R11).',
  });

export const ingestUploadSchema = z
  .object({
    filename: z
      .string()
      .trim()
      .min(3)
      .max(200)
      .regex(/^[^/\\\u0000-\u001F]+\.(pdf|txt|md|markdown|html?|csv)$/i, 'Allowed types: .pdf, .html, .txt, .md, .csv.'),
    contentBase64: z
      .string()
      .min(16, 'The file body is empty.')
      .regex(/^[A-Za-z0-9+/=\s]+$/, 'The file must be base64.'),
    ...ingestMeta,
  })
  .strict()
  .refine(requireLicenceForRestricted, {
    path: ['licenseNote'],
    message: 'A restricted source must state its licence terms before it can be recorded (R11).',
  });

export const ingestManifestSchema = z
  .object({
    csv: z.string().min(20, 'The manifest is empty.').max(400_000, 'Split the manifest into smaller files.'),
    /** Rows already marked `approved` are auto-approved by the submitting manager. */
    honorApprovedStatus: z.boolean().default(true),
  })
  .strict();

export const reviewChunkSchema = z
  .object({
    note: z.string().transform(stripControlChars).pipe(z.string().trim().max(500)).optional(),
  })
  .strict();

export const listDocumentsQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
    reviewState: z.enum(['PENDING_REVIEW', 'APPROVED', 'REJECTED', 'ALL']).default('ALL'),
  })
  .strict();

export const listChunksQuery = z
  .object({
    documentId: z.uuid().optional(),
    versionId: z.uuid().optional(),
    reviewState: z.enum(['PENDING_REVIEW', 'APPROVED', 'REJECTED', 'ALL']).default('ALL'),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export const recordFeedbackSchema = z
  .object({
    helpful: z.boolean().optional(),
    rating: z.coerce.number().int().min(1).max(5).optional(),
    issueType: z.enum(['WRONG_ANSWER', 'MISSING_SOURCE', 'STALE_SOURCE', 'LANGUAGE', 'OTHER']).optional(),
    comment: z
      .string()
      .transform(stripControlChars)
      .pipe(z.string().trim().max(1000))
      .optional(),
  })
  .strict()
  .refine((v) => v.helpful !== undefined || v.rating !== undefined || v.issueType !== undefined || v.comment !== undefined, {
    message: 'Nothing to record.',
  });

type AnyZod = z.ZodType<unknown>;

function toDetails(error: z.ZodError): Array<{ field: string; issue: string }> {
  return error.issues.slice(0, 20).map((issue) => ({
    field: issue.path.map(String).join('.') || '(body)',
    issue: issue.message,
  }));
}

/** Validates `req.body`, replacing it with the parsed (transformed) value. */
export function validateBody<T>(schema: z.ZodType<T>): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = (schema as AnyZod).safeParse(req.body ?? {});
    if (!result.success) {
      next(badRequest('Please check the highlighted fields.', toDetails(result.error)));
      return;
    }
    req.body = result.data;
    next();
  };
}

/** Validates `req.params`. */
export function validateParams<T>(schema: z.ZodType<T>): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = (schema as AnyZod).safeParse(req.params);
    if (!result.success) {
      next(badRequest('Invalid path parameter.', toDetails(result.error)));
      return;
    }
    Object.assign(req.params, result.data);
    next();
  };
}

/** Validates `req.query`. */
export function validateQuery<T>(schema: z.ZodType<T>): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = (schema as AnyZod).safeParse(req.query);
    if (!result.success) {
      next(badRequest('Invalid query parameters.', toDetails(result.error)));
      return;
    }
    (req as Request & { validatedQuery?: unknown }).validatedQuery = result.data;
    next();
  };
}

/** Reject oversized JSON bodies before parsing (§8 size limits). */
export const JSON_BODY_LIMIT = '64kb';
