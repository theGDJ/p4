package in.bissaathi.config;

import in.bissaathi.common.ApiException;

/**
 * Holds the {@link RequestContext} for the duration of one request.
 *
 * A ThreadLocal rather than a method parameter so a service two calls deep can scope
 * its query by user without every signature in between carrying the identity. It is
 * cleared by the filter in a finally block; nothing in this codebase spawns a thread
 * that reads it, and an async RAG pipeline must capture the context explicitly rather
 * than inherit it.
 */
public final class RequestContextHolder {

  private static final ThreadLocal<RequestContext> CURRENT = new ThreadLocal<>();

  private RequestContextHolder() {}

  static void set(RequestContext context) {
    CURRENT.set(context);
  }

  static void clear() {
    CURRENT.remove();
  }

  /** The current caller, or anonymous when no filter populated one. */
  public static RequestContext peek() {
    RequestContext context = CURRENT.get();
    return context == null ? RequestContext.ANONYMOUS : context;
  }

  /**
   * The current caller, or a 401.
   *
   * Named so that a query scoped by user cannot be written against the nullable
   * variant by accident.
   */
  public static RequestContext require() {
    RequestContext context = CURRENT.get();
    if (context == null || !context.authenticated()) {
      throw ApiException.unauthenticated("Authentication required.");
    }
    return context;
  }
}
