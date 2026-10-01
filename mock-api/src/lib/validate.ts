import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
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
  .refine((v) => /[A-Za-z]/.test(v), 'Include at least one letter.')
  .refine((v) => /\d/.test(v), 'Include at least one digit.');

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
