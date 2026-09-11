/**
 * True when a phone is written with a country code other than +1, the code the
 * US and Canada share. A "+" says a country code follows, so "+354 611 1234" is
 * Iceland, not area code 354. It is judged once everything but digits and "+"
 * is stripped: "(+44) 20 7946 0958" is foreign, "+ 1 205 259 8928" is not.
 *
 * A "+" with no 1 counts even where a US number was meant: "+8135550123" can't
 * be told apart from +81 Japan, and a rejected typo beats a dialed stranger.
 * Only a written code counts, so a foreign number that has lost its "+" isn't
 * caught here.
 *
 * Full-width characters, as a CJK keyboard types them, are read as the ASCII
 * they stand for before any of that, so "＋65 9234 5678" is foreign too.
 * Stripped as a mere symbol, a "＋" took its country code with it and left ten
 * bare digits — the length of a US number written without its 1.
 *
 * The one copy of the rule. toE164UsCa (the number a lead is stored and dialed
 * under), areaCodeOf (the state and timezone an import fills in) and
 * deriveCountry (the COUNTRY sent to Meta) all ask it, so they can't drift
 * apart. Keep it import-free: timezone.ts and twilio-lookup.ts both ship to the
 * browser, so no `server-only` and no server dependencies.
 */
export function hasForeignCountryCode(
  phone: string | null | undefined,
): boolean {
  const cleaned = (phone ?? "").normalize("NFKC").replace(/[^\d+]/g, "");
  return cleaned.startsWith("+") && !cleaned.startsWith("+1");
}
