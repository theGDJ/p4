package in.bissaathi.common;

import org.springframework.http.HttpStatus;

/**
 * The complete machine-readable error vocabulary (docs/API.md, "Error codes").
 *
 * A code is part of the contract and clients switch on it. Each maps to exactly one
 * HTTP status so a client never has to guess, and the message is always safe to
 * show a user: internals go to the log with the trace ref, not into the response.
 */
public enum ErrorCode {
  VALIDATION_FAILED(HttpStatus.BAD_REQUEST),
  UNAUTHENTICATED(HttpStatus.UNAUTHORIZED),
  INVALID_CREDENTIALS(HttpStatus.UNAUTHORIZED),
  REFRESH_REUSED(HttpStatus.UNAUTHORIZED),
  TOKEN_EXPIRED(HttpStatus.UNAUTHORIZED),
  FORBIDDEN(HttpStatus.FORBIDDEN),
  CSRF_FAILED(HttpStatus.FORBIDDEN),
  NOT_FOUND(HttpStatus.NOT_FOUND),
  CONFLICT(HttpStatus.CONFLICT),
  UNSUPPORTED_MEDIA_TYPE(HttpStatus.UNSUPPORTED_MEDIA_TYPE),
  RATE_LIMITED(HttpStatus.TOO_MANY_REQUESTS),
  ACCOUNT_LOCKED(HttpStatus.LOCKED),
  PROVIDER_UNAVAILABLE(HttpStatus.SERVICE_UNAVAILABLE),
  UNAVAILABLE(HttpStatus.SERVICE_UNAVAILABLE),
  INTERNAL(HttpStatus.INTERNAL_SERVER_ERROR);

  private final HttpStatus status;

  ErrorCode(HttpStatus status) {
    this.status = status;
  }

  public HttpStatus status() {
    return status;
  }
}
