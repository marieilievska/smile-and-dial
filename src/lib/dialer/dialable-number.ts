/**
 * The dial-time number gate: the one shape of number the AI dialer will call.
 *
 * ElevenLabs is handed a lead's stored number verbatim as `to_number`, and
 * nothing before this gate checked its shape. dial_queue, pre_call_check and
 * claim_lead_for_dial only ask whether it is null, and the number pool reads
 * an area code it can't parse as "no local match", not "don't dial". So a CSV
 * import's raw "+44 20 7946 0958" (toE164UsCa can't make it +1, so the import
 * keeps the text) or an inbound caller's "anonymous" could be dialed, and on
 * Eastern calling hours, since neither carries a timezone.
 *
 * "+1" and exactly ten ASCII digits is the E.164 form every US/Canada number
 * is stored in. Anything else is refused, never repaired: the dialer can't
 * know what a malformed value was meant to be, and a wrong guess dials a
 * stranger. Correcting the number on the lead is what makes it dialable.
 *
 * Import-free, like foreign-country-code.ts, so any layer can ask it.
 */
export function isDialableNumber(phone: string | null | undefined): boolean {
  return typeof phone === "string" && /^\+1\d{10}$/.test(phone);
}

/** Why the tick skipped a lead this gate refused. One name for both places it
 *  shows: the tick summary's blockedReasons (and so the dialer heartbeat), and
 *  the system_events kind on the lead's Activity feed. */
export const LEAD_PHONE_NOT_US_CA = "lead_phone_not_us_ca";
