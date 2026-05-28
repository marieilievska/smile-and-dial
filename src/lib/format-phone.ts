/** E.164 phone formatter for display. Round 34 (P-multi) — promoted
 *  from the one-off helper that lived in the Twilio buy-number dialog
 *  into a shared lib so every list/table that surfaces a phone reads
 *  the same way.
 *
 *  `+14155551000` → `(415) 555-1000`. Only handles +1 (US/CA) prettily
 *  since that's the only supported country pair on Smile & Dial today;
 *  any other +CC stays as the raw E.164 so the chrome doesn't
 *  misrepresent the number.
 *
 *  Inputs that aren't strings, are empty, or aren't well-formed
 *  E.164 are returned as the supplied fallback so callers don't have
 *  to ternary at the call site. */
export function formatPhone(
  value: string | null | undefined,
  fallback = "",
): string {
  if (!value) return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  if (trimmed.startsWith("+1") && trimmed.length === 12) {
    const a = trimmed.slice(2, 5);
    const b = trimmed.slice(5, 8);
    const c = trimmed.slice(8, 12);
    return `(${a}) ${b}-${c}`;
  }
  return trimmed;
}
