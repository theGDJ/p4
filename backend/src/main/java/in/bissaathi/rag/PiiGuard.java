package in.bissaathi.rag;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Personal-data detection and redaction before a turn is stored or sent onward
 * (§8, feature #7; mirrors mock-api/src/rag/guard.ts so both implementations behave
 * identically — the frontend reads the same flag from either).
 *
 * Three decisions worth stating:
 *
 *  1. Redaction happens **before persistence**, not only at the provider boundary.
 *     Keeping the raw text in the row "so the user can read their own history" sounds
 *     reasonable and quietly makes the database the most sensitive copy of Aadhaar
 *     numbers in the system, reachable by every future bug and every backup.
 *  2. A **residual fragment is kept** (last 4 digits of an Aadhaar, last 3 of a phone).
 *     Zero information makes an support exchange impossible; the tail is enough to
 *     correlate a report with a row and not enough to impersonate anyone.
 *  3. The user gets a short, factual notice — not a lecture. The `piiDetected` flag
 *     exists so the UI can say "we redacted this" once, in the answer's language.
 *
 * This is a guard rail, not a DLP: it covers the common Indian identifier shapes and a
 * bearer token, and anything else typed into a question is stored as written. That
 * limitation is in the docs for the same reason the rest of it is.
 */
public final class PiiGuard {

  /** 12 digits, optionally separated: 2345 6789 0123 / 2345-6789-0123 / 234567890123. */
  private static final Pattern AADHAAR = Pattern.compile(
      "(?<!\\d)(?:\\d[ -]?){11}\\d(?!\\d)");

  /** Permanent Account Number: five letters, four digits, one letter. */
  private static final Pattern PAN = Pattern.compile(
      "(?i)\\b[A-Z]{5}[0-9]{4}[A-Z]\\b");

  /**
   * Indian mobile, in the three forms people actually write: {@code 98765 43210},
   * {@code +91 98765 43210} and {@code 098765 43210}. The leading {@code 0} is the
   * trunk prefix and is as common as the other two, so an implementation that misses
   * it leaves most real numbers unredacted while looking correct in a test.
   *
   * Both lookarounds are load-bearing: without them the pattern would match inside a
   * longer digit run and mangle an order number, a GSTIN or a document id.
   */
  private static final Pattern PHONE = Pattern.compile(
      "(?<!\\d)((?:\\+?91|0)[ -]?)?([6-9]\\d{4})[ -]?(\\d{5})(?!\\d)");

  private static final Pattern EMAIL = Pattern.compile(
      "[A-Za-z0-9._%+\\-]+@[A-Za-z0-9.\\-]+\\.[A-Za-z]{2,}");

  /** A JWT pasted into a question must not be echoed back into a stored row. */
  private static final Pattern JWT = Pattern.compile(
      "\\beyJ[A-Za-z0-9_\\-]{8,}\\.[A-Za-z0-9_\\-]{8,}\\.[A-Za-z0-9_\\-]{8,}\\b");

  private static final String REDACTED = "[REDACTED]";

  private PiiGuard() {}

  public record Result(String redacted, boolean detected, List<String> kinds) {}

  /** Never returns null. An unrecognised shape is left as written. */
  public static Result scan(String input) {
    if (input == null || input.isBlank()) {
      return new Result(input == null ? "" : input, false, List.of());
    }

    List<String> kinds = new ArrayList<>(2);
    String out = input;

    Matcher jwt = JWT.matcher(out);
    if (jwt.find()) {
      kinds.add("token");
      out = JWT.matcher(out).replaceAll(REDACTED);
    }

    Matcher aadhaar = AADHAAR.matcher(out);
    if (aadhaar.find()) {
      // A bare 12-digit run is only an Aadhaar if all digits are present; anything
      // shorter stays untouched, so a standard number like 12345 is not mangled.
      String digits = aadhaar.group().replaceAll("\\D", "");
      if (digits.length() == 12) {
        kinds.add("aadhaar");
        String tail = digits.substring(8);
        final String masked = "XXXX-XXXX-" + tail;
        out = AADHAAR.matcher(out).replaceAll(Matcher.quoteReplacement(masked));
      }
    }

    Matcher pan = PAN.matcher(out);
    if (pan.find()) {
      kinds.add("pan");
      String found = pan.group();
      final String masked = found.substring(0, 2) + "*****" + found.substring(found.length() - 1);
      out = PAN.matcher(out).replaceAll(Matcher.quoteReplacement(masked));
    }

    Matcher phone = PHONE.matcher(out);
    if (phone.find()) {
      // A prefix must bring its own length: +91/91 implies 12 digits total, a trunk 0
      // implies 11, a bare national number implies 10. Anything else is a number that
      // happens to start with 6-9 — an order id, a revision year — and stays as typed.
      String whole = phone.group();
      String digits = whole.replaceAll("\\D", "");
      boolean prefixed = phone.group(1) != null;
      int expected = !prefixed ? 10 : digits.startsWith("0") ? 11 : 12;
      if (digits.length() == expected) {
        kinds.add("phone");
        String tail = digits.substring(digits.length() - 3);
        // Keep whatever the caller wrote before the 10-digit body, so "+91 " and "0"
        // survive the mask and the text still reads naturally.
        String prefix = whole.substring(0, whole.indexOf(phone.group(2)));
        final String masked = prefix + "XXXXX" + tail;
        out = PHONE.matcher(out).replaceAll(Matcher.quoteReplacement(masked));
      }
    }

    Matcher email = EMAIL.matcher(out);
    if (email.find()) {
      kinds.add("email");
      out = EMAIL.matcher(out).replaceAll(m -> {
        String value = m.group();
        int at = value.indexOf('@');
        return value.charAt(0) + "***" + value.substring(at);
      });
    }

    return new Result(out, !kinds.isEmpty(), List.copyOf(kinds));
  }

  /** Log-safe form of any string, for the DEBUG lines that quote a question. */
  public static String forLog(String input, int maxCharacters) {
    String redacted = scan(input).redacted();
    if (redacted.length() <= maxCharacters) return redacted;
    return redacted.substring(0, maxCharacters) + "…";
  }
}
