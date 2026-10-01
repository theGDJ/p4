import type { NextFunction, Request, Response } from 'express';
import { ERROR_CODES, type ErrorCode } from '../constants';
import { logger } from './logger';

/**
 * Application error carrying a public `code` and a safe `message`.
 * Internal causes stay on the error object and reach logs only — never the
 * response body (§8 "safe error bodies").
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: unknown;
  readonly headers?: Record<string, string>;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    opts: { details?: unknown; headers?: Record<string, string>; cause?: unknown } = {},
  ) {
    // `cause` is the standard ES2022 slot: internal-only, never serialised to the client.
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = opts.details;
    this.headers = opts.headers;
    this.cause = opts.cause;
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, ERROR_CODES.VALIDATION_FAILED, message, { details });
export const unauthenticated = (message = 'Authentication required.') =>
  new AppError(401, ERROR_CODES.UNAUTHENTICATED, message);
export const invalidCredentials = () =>
  // Deliberately identical for unknown email and wrong password: no account enumeration.
  new AppError(401, ERROR_CODES.INVALID_CREDENTIALS, 'Incorrect email or password.');
export const refreshReused = () =>
  new AppError(
    401,
    ERROR_CODES.REFRESH_REUSED,
    'This session was ended for security reasons. Please sign in again.',
  );
export const forbidden = (message = 'You do not have access to this resource.') =>
  new AppError(403, ERROR_CODES.FORBIDDEN, message);
export const csrfFailed = () =>
  new AppError(403, ERROR_CODES.CSRF_FAILED, 'Missing or invalid anti-CSRF token.');
/** R9: absent and not-owned are indistinguishable to the caller. */
export const notFound = (what = 'Resource') => new AppError(404, ERROR_CODES.NOT_FOUND, `${what} not found.`);
export const conflict = (message: string) => new AppError(409, ERROR_CODES.CONFLICT, message);
export const accountLocked = (retryAfterSeconds: number) =>
  new AppError(423, ERROR_CODES.ACCOUNT_LOCKED, 'Too many failed sign-in attempts. Try again later.', {
    headers: { 'Retry-After': String(retryAfterSeconds) },
  });
export const rateLimited = (retryAfterSeconds: number) =>
  new AppError(429, ERROR_CODES.RATE_LIMITED, 'Too many requests. Please slow down.', {
    headers: { 'Retry-After': String(retryAfterSeconds) },
  });
export const providerUnavailable = (message = 'The answer service is temporarily unavailable.') =>
  new AppError(502, ERROR_CODES.PROVIDER_UNAVAILABLE, message);

/** Short, non-secret correlation id surfaced as `traceRef` and in logs. */
export function newTraceRef(): string {
  return `req_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

export function errorBody(err: AppError, traceRef: string) {
  return {
    error: {
      code: err.code,
      message: err.message,
      ...(err.details !== undefined ? { details: err.details } : {}),
      traceRef,
    },
  };
}

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(notFound(`Route ${req.method} ${req.path}`));
}

/**
 * Terminal error handler. Express 5 forwards rejected promises from async
 * handlers here automatically, so route code can stay `async` without wrappers.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const traceRef = (req as Request & { traceRef?: string }).traceRef ?? newTraceRef();

  // Body-parser / payload errors surface with a status but no AppError shape.
  const bodyErr = err as { type?: string; status?: number; statusCode?: number; message?: string };
  if (bodyErr?.type === 'entity.too.large') {
    const e = new AppError(413, ERROR_CODES.PAYLOAD_TOO_LARGE, 'Request body is too large.');
    res.status(413).json(errorBody(e, traceRef));
    return;
  }
  if (bodyErr?.type === 'entity.parse.failed') {
    const e = badRequest('Request body is not valid JSON.');
    res.status(400).json(errorBody(e, traceRef));
    return;
  }

  if (err instanceof AppError) {
    for (const [k, v] of Object.entries(err.headers ?? {})) res.setHeader(k, v);
    if (err.status >= 500) {
      logger.error('request failed', { traceRef, code: err.code, path: req.path, cause: err.cause });
    } else {
      logger.warn('request rejected', { traceRef, code: err.code, path: req.path, status: err.status });
    }
    res.status(err.status).json(errorBody(err, traceRef));
    return;
  }

  // Anything unexpected: log the real cause, tell the client nothing useful.
  logger.error('unhandled error', { traceRef, path: req.path, method: req.method, err });
  const e = new AppError(500, ERROR_CODES.INTERNAL_ERROR, 'Something went wrong on our side.');
  res.status(500).json(errorBody(e, traceRef));
}
