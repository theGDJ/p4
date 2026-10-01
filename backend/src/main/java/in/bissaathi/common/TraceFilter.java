package in.bissaathi.common;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.security.SecureRandom;
import org.slf4j.MDC;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Assigns every request a short opaque trace reference.
 *
 * The ref is echoed as {@code X-Trace-Ref} and appears in error bodies and logs, so
 * a user report can be matched to a log line without either side having to share
 * personal data. It is random, not sequential: a predictable ref would let a caller
 * probe how much traffic the service is handling.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class TraceFilter extends OncePerRequestFilter {

  public static final String HEADER = "X-Trace-Ref";
  public static final String MDC_KEY = "traceRef";

  private static final char[] ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz".toCharArray();
  private static final int LENGTH = 16;

  private final SecureRandom random = new SecureRandom();

  @Override
  protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
      throws ServletException, IOException {
    String traceRef = newTraceRef();
    MDC.put(MDC_KEY, traceRef);
    response.setHeader(HEADER, traceRef);
    try {
      chain.doFilter(request, response);
    } finally {
      MDC.remove(MDC_KEY);
    }
  }

  private String newTraceRef() {
    StringBuilder builder = new StringBuilder(LENGTH);
    for (int i = 0; i < LENGTH; i++) {
      builder.append(ALPHABET[random.nextInt(ALPHABET.length)]);
    }
    return builder.toString();
  }

  /** Current request's trace ref, or empty when called outside a request thread. */
  public static String current() {
    String value = MDC.get(MDC_KEY);
    return value == null ? "" : value;
  }
}
