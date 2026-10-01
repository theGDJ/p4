package in.bissaathi.common;

import jakarta.servlet.http.HttpServletRequest;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.core.AuthenticationException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.servlet.NoHandlerFoundException;

/**
 * One place where failures become HTTP responses (§8).
 *
 * Two rules drive every branch here:
 *  1. The client gets a code, a human-safe message and a trace ref. Never a stack
 *     trace, a bean-validation default message, or an internal exception type.
 *  2. An unexpected exception is logged at ERROR with the trace ref and returned as
 *     a generic INTERNAL. Swallowing it or guessing at a friendlier message would
 *     hide a real bug (R8).
 */
@RestControllerAdvice
public class GlobalExceptionHandler {

  private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

  @ExceptionHandler(ApiException.class)
  public ResponseEntity<ApiErrorBody> handleApi(ApiException ex, HttpServletRequest request) {
    ErrorCode code = ex.code();
    // A 5xx from our own code is a bug, not an expected outcome: log it.
    if (code.status().is5xxServerError()) {
      log.error("api failure code={} path={} trace={}", code, request.getRequestURI(), TraceFilter.current(), ex);
    } else {
      log.debug("api rejection code={} path={} trace={}", code, request.getRequestURI(), TraceFilter.current());
    }
    ResponseEntity.BodyBuilder builder = ResponseEntity.status(code.status());
    if (code == ErrorCode.ACCOUNT_LOCKED || code == ErrorCode.RATE_LIMITED) {
      // Retry-After is how a well-behaved client backs off without guessing.
      String retryAfter = ex.hint() == null ? "60" : ex.hint();
      builder.header("Retry-After", retryAfter);
    }
    return builder.body(ApiErrorBody.of(code, ex.getMessage(), ex.details(), TraceFilter.current()));
  }

  /** Bean Validation failures become field issues the form can bind to. */
  @ExceptionHandler(MethodArgumentNotValidException.class)
  public ResponseEntity<ApiErrorBody> handleValidation(MethodArgumentNotValidException ex) {
    List<ApiException.FieldIssue> details =
        ex.getBindingResult().getFieldErrors().stream()
            .map(fieldError -> new ApiException.FieldIssue(fieldError.getField(), fieldError.getDefaultMessage()))
            .toList();
    return ResponseEntity.badRequest()
        .body(
            ApiErrorBody.of(
                ErrorCode.VALIDATION_FAILED,
                "Please check the highlighted fields.",
                details,
                TraceFilter.current()));
  }

  /**
   * A malformed body, a wrong enum value or an unknown JSON key all land here.
   *
   * Unknown keys are rejected because {@code fail-on-unknown-properties} is on:
   * that is what stops a client from smuggling {@code roles} or
   * {@code emailVerified} into PATCH /users/me (§8 privilege escalation).
   */
  @ExceptionHandler(HttpMessageNotReadableException.class)
  public ResponseEntity<ApiErrorBody> handleUnreadable(HttpMessageNotReadableException ex) {
    log.debug("unreadable request body: {}", ex.getMostSpecificCause().getMessage());
    // The cause message can quote the offending payload, so it is logged and not
    // returned.
    return ResponseEntity.badRequest()
        .body(ApiErrorBody.of(ErrorCode.VALIDATION_FAILED, "Please check the highlighted fields.", TraceFilter.current()));
  }

  @ExceptionHandler(MethodArgumentTypeMismatchException.class)
  public ResponseEntity<ApiErrorBody> handleTypeMismatch(MethodArgumentTypeMismatchException ex) {
    return ResponseEntity.badRequest()
        .body(
            ApiErrorBody.of(
                ErrorCode.VALIDATION_FAILED,
                "Please check the highlighted fields.",
                List.of(new ApiException.FieldIssue(ex.getName(), "Invalid value")),
                TraceFilter.current()));
  }

  @ExceptionHandler(NoHandlerFoundException.class)
  public ResponseEntity<ApiErrorBody> handleNoHandler(NoHandlerFoundException ex) {
    return ResponseEntity.status(HttpStatus.NOT_FOUND)
        .body(ApiErrorBody.of(ErrorCode.NOT_FOUND, "Not found", TraceFilter.current()));
  }

  @ExceptionHandler(AccessDeniedException.class)
  public ResponseEntity<ApiErrorBody> handleAccessDenied(AccessDeniedException ex, HttpServletRequest request) {
    // Audited by AuditService at the point of denial; this handler only shapes the
    // response. A 403 must not disclose what the resource was.
    log.info("access denied path={} trace={}", request.getRequestURI(), TraceFilter.current());
    return ResponseEntity.status(HttpStatus.FORBIDDEN)
        .body(ApiErrorBody.of(ErrorCode.FORBIDDEN, "You do not have access to this resource.", TraceFilter.current()));
  }

  @ExceptionHandler(AuthenticationException.class)
  public ResponseEntity<ApiErrorBody> handleAuthentication(AuthenticationException ex) {
    return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
        .body(ApiErrorBody.of(ErrorCode.UNAUTHENTICATED, "Authentication required.", TraceFilter.current()));
  }

  @ExceptionHandler(Exception.class)
  public ResponseEntity<ApiErrorBody> handleUnexpected(Exception ex, HttpServletRequest request) {
    log.error("unhandled exception path={} trace={}", request.getRequestURI(), TraceFilter.current(), ex);
    return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
        .body(ApiErrorBody.of(ErrorCode.INTERNAL, "Something went wrong. Please try again.", TraceFilter.current()));
  }
}
