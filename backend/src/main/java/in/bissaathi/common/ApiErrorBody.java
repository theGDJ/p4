package in.bissaathi.common;

import java.util.List;

/**
 * The error envelope (docs/API.md, "Safe error bodies").
 *
 * Exactly three guaranteed fields plus optional detail. A stack trace, a SQL
 * fragment, a class name or an internal message never appears here; the traceRef is
 * the only bridge to the log, and it carries no user data.
 */
public record ApiErrorBody(Error error) {

  public record Error(
      String code,
      String message,
      List<ApiException.FieldIssue> details,
      String traceRef) {

    public static Error of(ErrorCode code, String message, List<ApiException.FieldIssue> details, String traceRef) {
      return new Error(code.name(), message, details == null || details.isEmpty() ? List.of() : details, traceRef);
    }
  }

  public static ApiErrorBody of(ErrorCode code, String message, String traceRef) {
    return new ApiErrorBody(Error.of(code, message, List.of(), traceRef));
  }

  public static ApiErrorBody of(ErrorCode code, String message, List<ApiException.FieldIssue> details, String traceRef) {
    return new ApiErrorBody(Error.of(code, message, details, traceRef));
  }
}
