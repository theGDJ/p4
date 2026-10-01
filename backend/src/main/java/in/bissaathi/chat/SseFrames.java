package in.bissaathi.chat;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.io.Writer;

/**
 * Server-Sent Event framing for the message stream.
 *
 * Two details that break clients when they are wrong:
 *  - A frame must end with a blank line, and a JSON payload must never contain a bare
 *    newline outside a `data:` prefix. The payload is serialised compactly and every
 *    newline inside it is escaped by JSON, so a single `data:` line is always valid.
 *  - Flushing is not optional. Buffering until the response ends would turn a
 *    progressive stream into one delayed blob and the UI would look hung.
 */
final class SseFrames {

  private final Writer writer;
  private final ObjectMapper mapper;

  SseFrames(Writer writer, ObjectMapper mapper) {
    this.writer = writer;
    this.mapper = mapper;
  }

  void send(String event, Object payload) throws IOException {
    writer.write("event: " + event + "\n");
    writer.write("data: " + mapper.writeValueAsString(payload) + "\n\n");
    writer.flush();
  }

  /** Called once before any frame, so intermediaries do not buffer the response. */
  static void prime(Writer writer) throws IOException {
    writer.write(": bis-saathi stream\n\n");
    writer.flush();
  }
}
