import { toE164UsCa } from "./twilio-lookup";

/**
 * A phone number a PERSON supplied — typed on the lead page, or said out loud
 * to the agent on a call — in E.164, or null when it isn't one we can use.
 *
 * `toE164UsCa` decides what counts as a US/Canada number at all, and rejects
 * an explicit country code other than +1 (#518). This adds the NANP shape on
 * top: no area code or exchange starts with 0 or 1, so "111-111-1111" is not a
 * number anyone has. That check earns its place for these two sources in
 * particular, because they fail by typo and by mishearing — one digit heard
 * wrong still reads as a perfectly shaped number. Best-effort: it cannot know
 * whether an area code is actually in service.
 *
 * The one copy of the rule. It lived inside calendly/booking.ts as
 * `toBookableUsCaPhone` while the texting path kept a looser copy that
 * prefixed "+" onto anything, so the very same cell could be refused for a
 * booking and stored for a text. Pure, and import-free beyond toE164UsCa, so
 * any layer can ask it.
 */
export function toUsCaPhone(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const e164 = toE164UsCa(raw);
  return e164 && /^\+1[2-9]\d{2}[2-9]\d{6}$/.test(e164) ? e164 : null;
}
