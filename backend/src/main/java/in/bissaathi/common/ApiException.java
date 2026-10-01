package in.bissaathi.common;

import java.util.List;

/**
 * The single exception type every module throws for an expected failure.
 *
 * Carrying an {@link ErrorCode} rather than a raw status means the mapping to HTTP
 * lives in exactly one place and cannot drift between modules. Field-level issues
 * ride along so a form can bind an error to the right control.
 */
public class ApiException extends RuntimeException {

  /** One field-level problem, safe to show the user. */
  public record FieldIssue(String field, String issue) {}

  private final ErrorCode code;
  private final List<FieldIssue> details;
  /** Optional non-sensitive detail for support, e.g. a rate-limit window. */
  private final String hint;

  public ApiException(ErrorCode code, String message) {
    this(code, message, List.of(), null, null);
  }

  public ApiException(ErrorCode code, String message, List<FieldIssue> details) {
    this(code, message, details, null, null);
  }

  public ApiException(ErrorCode code, String message, String hint) {
    this(code, message, List.of(), hint, null);
  }

  public ApiException(ErrorCode code, String message, List<FieldIssue> details, String hint, Throwable cause) {
    super(message, cause);
    this.code = code;
    this.details = details == null ? List.of() : List.copyOf(details);
    this.hint = hint;
  }

  public ErrorCode code() {
    return code;
  }

  public List<FieldIssue> details() {
    return details;
  }

  public String hint() {
    return hint;
  }

  /* ---------------------------------------------------------------- factories */

  public static ApiException notFound() {
    // Deliberately identical for "does not exist" and "exists but is not yours":
    // distinguishing them would confirm the existence of another user's data (R9).
    return new ApiException(ErrorCode.NOT_FOUND, "Not found");
  }

  public static ApiException unauthenticated(String message) {
    return new ApiException(ErrorCode.UNAUTHENTICATED, message);
  }

  public static ApiException forbidden(String message) {
    return new ApiException(ErrorCode.FORBIDDEN, message);
  }

  public static ApiException validation(String message, List<FieldIssue> details) {
    return new ApiException(ErrorCode.VALIDATION_FAILED, message, details);
  }

  public static ApiException conflict(String message) {
    return new ApiException(ErrorCode.CONFLICT, message);
  }

  public static ApiException rateLimited(String message, String hint) {
    return new ApiException(ErrorCode.RATE_LIMITED, message, hint);
  }

  public static ApiException locked(String message, String hint) {
    return new ApiException(ErrorCode.ACCOUNT_LOCKED, message, hint);
  }

  /** A missing or mismatched double-submit token: a rejection, never a warning. */
  public static ApiException forbiddenCsrf() {
    return new ApiException(ErrorCode.CSRF_FAILED, "Your session expired. Please sign in again.");
  }

  /**
   * R8: a provider failure is reported as a failure. It is never converted into a
   * plausible-looking answer, and it is never reported as success.
   */
  public static ApiException providerUnavailable(String message) {
    return new ApiException(ErrorCode.PROVIDER_UNAVAILABLE, message);
  }
}
