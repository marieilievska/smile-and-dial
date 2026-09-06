/** Which Close number the agent texts from. Pure (no I/O) so the choice is
 *  unit-tested without touching Close or the database.
 *
 *  Product decision (owner, 2026-09-05): "the send from number is not
 *  configurable, it's whatever number we choose from Close directly." So the
 *  app reads the organisation's numbers from Close's phone-number endpoint
 *  (`GET /api/v1/phone_number/`, see listCloseSmsNumbers in ./api.ts), keeps
 *  the SMS-capable ones, and picks one automatically; the Close card lets the
 *  user pick another when several exist. */

/** One SMS-capable Close number, as stored in user_integrations.close_sms_numbers. */
export type CloseSmsNumber = {
  /** E.164, e.g. "+16503335555" — the `local_phone` an outbox SMS sends from. */
  number: string;
  /** Close's display form ("+1 650-333-5555"). */
  formatted: string;
  /** The label the Close user gave it ("Personal Number", "Support line"). */
  label: string;
  /** The Close user this number belongs to; null for a group number. */
  userId: string | null;
  isGroup: boolean;
};

/** A phone number as Close returns it (only the fields we read). */
export type ClosePhoneNumberRecord = {
  number?: string | null;
  number_formatted?: string | null;
  label?: string | null;
  user_id?: string | null;
  is_group_number?: boolean | null;
  sms_enabled?: boolean | null;
  /** "internal" = owned and run by Close (can send); "external" / "virtual" =
   *  the org's own lines used for caller ID / BYOC, which Close can't text from. */
  type?: string | null;
};

/** Keep the numbers Close can actually text FROM: `sms_enabled` and of type
 *  "internal" (Close-owned). An "external" number is a caller-ID entry for the
 *  user's own cell — Close reports `sms_enabled: false` for those anyway, but
 *  the type check makes the rule explicit. Order is preserved. */
export function smsCapableNumbers(
  records: ClosePhoneNumberRecord[],
): CloseSmsNumber[] {
  const out: CloseSmsNumber[] = [];
  const seen = new Set<string>();
  for (const r of records) {
    const number = r.number?.trim() ?? "";
    if (!number || !r.sms_enabled || r.type !== "internal") continue;
    if (seen.has(number)) continue;
    seen.add(number);
    out.push({
      number,
      formatted: r.number_formatted?.trim() || number,
      label: r.label?.trim() || "",
      userId: r.user_id ?? null,
      isGroup: Boolean(r.is_group_number),
    });
  }
  return out;
}

/** Choose the number to text from.
 *    1. the current choice, when it is still SMS-capable — a working setup is
 *       never silently swapped by a refresh;
 *    2. a number assigned to the connecting Close user (their own line), so a
 *       lead who texts back reaches the person whose campaign it was;
 *    3. any other SMS-capable number (a group line, a teammate's);
 *    4. null when Close has nothing that can text — the caller must be
 *       honest about it, never fall back to some unrelated number. */
export function pickSmsFromNumber(
  numbers: CloseSmsNumber[],
  opts: { closeUserId: string | null; current: string | null },
): string | null {
  const current = opts.current?.trim() || null;
  if (current && numbers.some((n) => n.number === current)) return current;
  if (opts.closeUserId) {
    const own = numbers.find((n) => n.userId === opts.closeUserId);
    if (own) return own.number;
  }
  return numbers[0]?.number ?? null;
}

/** Parse the stored `close_sms_numbers` jsonb back into the typed list. Anything
 *  malformed (an older row, a hand edit) yields [] rather than throwing. */
export function parseCloseSmsNumbers(value: unknown): CloseSmsNumber[] {
  if (!Array.isArray(value)) return [];
  const out: CloseSmsNumber[] = [];
  for (const v of value) {
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    if (typeof o.number !== "string" || !o.number) continue;
    out.push({
      number: o.number,
      formatted: typeof o.formatted === "string" ? o.formatted : o.number,
      label: typeof o.label === "string" ? o.label : "",
      userId: typeof o.userId === "string" ? o.userId : null,
      isGroup: o.isGroup === true,
    });
  }
  return out;
}
