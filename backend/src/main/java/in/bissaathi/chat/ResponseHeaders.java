package in.bissaathi.chat;

import jakarta.servlet.http.HttpServletResponse;

/**
 * Response headers that make SSE behave.
 *
 * `no-cache` (not `no-store`) so a shared cache may still store-and-revalidate; the
 * real requirement is that nothing buffers the stream. Proxy buffering is the usual
 * reason an SSE stream appears to hang for the whole answer and then dump everything
 * at once, and `X-Accel-Buffering: no` is how nginx is told not to.
 */
final class ResponseHeaders {

  private ResponseHeaders() {}

  static void disableBuffering(HttpServletResponse response) {
    response.setContentType("text/event-stream;charset=UTF-8");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    // A 200 with an error frame inside is what the client is designed to read; the
    // status is set before the first flush because headers are useless afterwards.
    response.setStatus(HttpServletResponse.SC_OK);
  }
}
