package in.bissaathi.common;

/**
 * Self-declared audience segment.
 *
 * A persona shapes phrasing and follow-up questions. It is NEVER an authorization
 * input: §4 is explicit that only roles gate access, and a persona is editable by
 * the account holder.
 */
public enum Persona {
  CONSUMER,
  MSME_MANUFACTURER,
  JEWELLER_RETAILER,
  STUDENT_ENGINEER
}
