import { describe, expect, it } from "vitest";

import { toUsCaPhone } from "@/lib/leads/us-ca-phone";

/**
 * The one rule for a phone number a PERSON supplies — typed on the lead page,
 * or read out loud to the agent on a call. It is `toE164UsCa` plus a NANP
 * shape check, because those two sources fail in a way an import doesn't:
 * a typo or a misheard digit. No NANP area code or exchange starts with 0 or
 * 1, so "111-111-1111" is not a number anyone has.
 *
 * It lived inside calendly/booking.ts as `toBookableUsCaPhone` while the
 * texting path kept a looser copy of its own that prefixed "+" onto anything —
 * so a foreign cell, or half of one, was stored on the lead and then used as
 * the booking phone. Same rule, one file, three callers now.
 */

describe("toUsCaPhone — a US or Canadian number, however it was said", () => {
  it.each([
    ["bare 10 digits", "2052598928"],
    ["11 digits with the leading 1", "12052598928"],
    ["already E.164", "+12052598928"],
    ["parentheses and a dash", "(205) 259-8928"],
    ["dots", "205.259.8928"],
    ["spaces", "205 259 8928"],
    ["+1 with pretty formatting", "+1 (205) 259-8928"],
    ["surrounding whitespace", "  205-259-8928  "],
  ])("%s (%s) is +12052598928", (_format, raw) => {
    expect(toUsCaPhone(raw)).toBe("+12052598928");
  });

  it("a Canadian cell is a US/CA number too", () => {
    expect(toUsCaPhone("(416) 555-0123")).toBe("+14165550123");
  });
});

describe("toUsCaPhone — a number nobody has is not a number", () => {
  it.each([
    // No NANP area code or exchange starts with 0 or 1.
    ["an area code starting with 1", "111-111-1111"],
    ["an area code starting with 0", "012-259-8928"],
    ["an exchange starting with 1", "205-159-8928"],
    ["an exchange starting with 0", "205-059-8928"],
  ])("%s (%s) is refused", (_what, raw) => {
    expect(toUsCaPhone(raw)).toBeNull();
  });

  it.each([
    ["the UK", "+44 20 7946 0958"],
    ["Singapore", "+65 9234 5678"],
    // A full-width "＋" is still a country code (#532).
    ["Singapore typed full-width", "＋65 9234 5678"],
  ])("%s (%s) is refused", (_country, raw) => {
    expect(toUsCaPhone(raw)).toBeNull();
  });

  it.each([
    ["half a number", "205-259"],
    ["a word", "anonymous"],
    ["an extension", "(205) 259-8928 ext. 12"],
    ["empty", ""],
    ["only spaces", "   "],
  ])("%s (%s) is refused", (_what, raw) => {
    expect(toUsCaPhone(raw)).toBeNull();
  });

  it("no number at all is refused", () => {
    expect(toUsCaPhone(null)).toBeNull();
    expect(toUsCaPhone(undefined)).toBeNull();
  });
});
