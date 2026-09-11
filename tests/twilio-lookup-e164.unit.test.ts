import { describe, expect, it } from "vitest";

import { isUsCaNumber, toE164UsCa } from "../src/lib/leads/twilio-lookup";

/**
 * toE164UsCa decides the number a lead is stored, deduped and dialed under,
 * and the number a DNC entry blocks. A wrong answer never fails loudly: it
 * turns someone's foreign number into a real-looking US number that belongs
 * to a stranger. So both directions are pinned:
 *   - every common way of writing a US/Canada number comes out +1XXXXXXXXXX;
 *   - anything else is null, never a guess. An explicit country code other
 *     than +1 is foreign even when its digits total ten, which is exactly the
 *     length of a US number written without its 1.
 */

describe("toE164UsCa — US/Canada numbers in every format we accept", () => {
  it.each([
    ["bare 10 digits", "2052598928"],
    ["11 digits with the leading 1", "12052598928"],
    ["already E.164", "+12052598928"],
    ["parentheses and a dash", "(205) 259-8928"],
    ["dots", "205.259.8928"],
    ["spaces", "205 259 8928"],
    ["+1 with pretty formatting", "+1 (205) 259-8928"],
    ["a 1- prefix with dashes", "1-205-259-8928"],
    ["surrounding whitespace", "  205-259-8928  "],
  ])("%s (%s) is +12052598928", (_format, input) => {
    expect(toE164UsCa(input)).toBe("+12052598928");
  });

  it("a Canadian number is +1 as well", () => {
    expect(toE164UsCa("(416) 555-0123")).toBe("+14165550123");
  });
});

describe("toE164UsCa — null rather than a guess", () => {
  it("an extension is not folded into the number", () => {
    expect(toE164UsCa("(205) 259-8928 ext. 12")).toBeNull();
    expect(toE164UsCa("205-259-8928 x5")).toBeNull();
  });

  it("7 digits (no area code) is null", () => {
    expect(toE164UsCa("259-8928")).toBeNull();
  });

  it("11 digits that don't start with 1 is null", () => {
    expect(toE164UsCa("22052598928")).toBeNull();
  });

  it("an empty value is null", () => {
    expect(toE164UsCa("")).toBeNull();
  });
});

describe("toE164UsCa — a country code other than +1 is foreign", () => {
  // Ten digits in total, country code included: the length of a bare US
  // number, so a digit count alone reads these as US area codes 354, 659, 453…
  it.each([
    ["Iceland", "+354 611 1234"],
    ["Singapore", "+65 9234 5678"],
    ["Denmark", "+45 32 12 34 56"],
    ["Norway", "+47 22 12 34 56"],
    ["Estonia", "+372 612 3456"],
  ])("%s %s is not a US number", (_country, input) => {
    expect(toE164UsCa(input)).toBeNull();
  });

  it.each([
    ["9", "Andorra", "+376 712 345"],
    ["11", "Australia", "+61 2 9876 5432"],
    ["12", "the UK", "+44 20 7946 0958"],
    ["13", "Germany", "+49 151 2345 6789"],
  ])("%s digits in total (%s, %s) is null", (_digits, _country, input) => {
    expect(toE164UsCa(input)).toBeNull();
  });

  it("a + with no 1 is a country code even when a US number was meant", () => {
    // "+8135550123" could be Tampa's 813 with the 1 dropped, or +81 Japan, and
    // nothing in the string tells the two apart. The plus says a country code
    // follows. Rejecting a mistyped US number surfaces as an error someone can
    // fix; guessing wrong dials a stranger. So it is read as foreign.
    expect(toE164UsCa("+8135550123")).toBeNull();
  });
});

describe("isUsCaNumber — only +1 followed by ten digits", () => {
  it("is true for E.164 US/CA, formatting aside", () => {
    expect(isUsCaNumber("+12052598928")).toBe(true);
    expect(isUsCaNumber("+1 (205) 259-8928")).toBe(true);
  });

  it("is false for a number not yet in E.164 (toE164UsCa's job)", () => {
    expect(isUsCaNumber("2052598928")).toBe(false);
    expect(isUsCaNumber("12052598928")).toBe(false);
    expect(isUsCaNumber("(205) 259-8928")).toBe(false);
  });

  it("is false for a foreign number, ten-digit ones included", () => {
    for (const phone of [
      "+354 611 1234",
      "+65 9234 5678",
      "+44 20 7946 0958",
    ]) {
      expect(isUsCaNumber(phone)).toBe(false);
    }
  });

  it("is false with an extension or the wrong digit count", () => {
    expect(isUsCaNumber("+120525989281")).toBe(false);
    expect(isUsCaNumber("+1205259892")).toBe(false);
  });
});

/** Text as typed on a full-width (CJK) keyboard: each ASCII symbol and digit
 *  becomes its U+FFxx twin, so "+" is "＋" (U+FF0B) and "2" is "２". */
const fullWidth = (s: string) =>
  s.replace(/[!-~]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0xfee0));

describe("toE164UsCa — full-width characters read as what they stand for", () => {
  it("a full-width plus is still a country code, so Singapore stays foreign", () => {
    // Was "+16592345678". The "＋" was stripped like any other symbol, which
    // left ten digits, the length of a bare US number: a stranger in 659.
    expect(toE164UsCa("＋65 9234 5678")).toBeNull();
    expect(toE164UsCa(fullWidth("+65 9234 5678"))).toBeNull();
  });

  it.each([
    ["full-width digits", fullWidth("(205) 259-8928")],
    ["a full-width +1 number", fullWidth("+1 205 259 8928")],
    ["a full-width plus before 1", "＋1 205 259 8928"],
  ])("%s (%s) is +12052598928", (_what, input) => {
    expect(toE164UsCa(input)).toBe("+12052598928");
  });
});
