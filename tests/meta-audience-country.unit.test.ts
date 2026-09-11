// tests/meta-audience-country.unit.test.ts
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { CANADA_AREA_CODES } from "../src/lib/dialer/nanp-states";
import {
  deriveCountry,
  leadToHashedRow,
  META_SCHEMA,
  type LeadForAudience,
} from "../src/lib/meta/audience-fields";

/**
 * deriveCountry fills the COUNTRY column of every row uploaded to a Meta
 * Custom Audience, and of the CSV export for a manual upload. Meta matches
 * people on it alongside the email and phone, so a wrong country is a false
 * statement sent to Meta, not a cosmetic one. It went wrong two ways:
 *   - it kept its own list of Canadian area codes, 16 behind the dialer's, so
 *     a lead on a newer Canadian code went up as US;
 *   - it ignored a "+" country code, so the first three digits of a foreign
 *     number passed for a US or Canadian area code.
 * US and CA are the only countries it can name, and for a foreign number both
 * are guesses, so it names none: null, which uploads as an empty cell.
 */

function lead(
  phone: string | null,
  state: string | null = null,
): LeadForAudience {
  return {
    business_email: "owner@example.com",
    business_phone: phone,
    city: null,
    state,
  };
}

describe("deriveCountry — Canada comes from the dialer's NANP map", () => {
  // [area code, province]. All four were missing from the list of Canadian
  // codes this file used to keep, so leads on them went to Meta as US.
  const NEWER_CODES: [code: string, province: string][] = [
    ["354", "QC"],
    ["257", "BC"],
    ["368", "AB"],
    ["942", "ON"],
  ];

  it.each(NEWER_CODES)("a %s number (%s) is CA", (code) => {
    expect(deriveCountry(lead(`+1${code}5550123`))).toBe("CA");
  });

  it("agrees with the dialer's map on every Canadian area code", () => {
    const notCa = [...CANADA_AREA_CODES].filter(
      (code) => deriveCountry(lead(`+1${code}5550123`)) !== "CA",
    );
    expect(notCa).toEqual([]);
  });
});

describe("deriveCountry — a US number is US in every format", () => {
  // toE164UsCa's formats, plus a space after the "+". Only the cleaned
  // string reads "+1" there, so a check on the raw text would call it foreign.
  const US_FORMATS: [format: string, phone: string][] = [
    ["bare 10 digits", "2052598928"],
    ["11 digits with the leading 1", "12052598928"],
    ["already E.164", "+12052598928"],
    ["parentheses and a dash", "(205) 259-8928"],
    ["dots", "205.259.8928"],
    ["spaces", "205 259 8928"],
    ["+1 with pretty formatting", "+1 (205) 259-8928"],
    ["a 1- prefix with dashes", "1-205-259-8928"],
    ["surrounding whitespace", "  205-259-8928  "],
    ["a space after the plus", "+ 1 205 259 8928"],
  ];

  it.each(US_FORMATS)("%s (%s) is US", (_format, phone) => {
    expect(deriveCountry(lead(phone))).toBe("US");
  });
});

describe("deriveCountry — a country code other than +1 is foreign", () => {
  // Every one of these went to Meta as US or CA.
  const FOREIGN: [country: string, phone: string][] = [
    // Ten digits, the length of a US number, so the first three pass for an
    // area code:
    ["New Zealand", "+64 7 123 4567"], // 647 is Toronto: sent as CA
    ["Iceland", "+354 611 1234"], // 354 is Quebec: US, and CA on the new list
    ["Singapore", "+65 9234 5678"], // 659 is Alabama: sent as US
    // Twelve, no area code at all, so it fell through to the US default:
    ["the UK", "+44 20 7946 0958"],
    // The "+" isn't first in the raw text; it is once the text is cleaned.
    ["the UK, + in brackets", "(+44) 20 7946 0958"],
    // A CJK keyboard's full-width "＋" (U+FF0B) is still a plus. Stripped as
    // a symbol, it left 659, Alabama: sent as US.
    ["Singapore, full-width plus", "＋65 9234 5678"],
  ];

  it.each(FOREIGN)("%s (%s) is neither US nor CA", (_country, phone) => {
    expect(deriveCountry(lead(phone))).toBeNull();
  });

  it("reads a + with no 1 as foreign, even where a US number was meant", () => {
    // The call #518 made in toE164UsCa: "+8135550123" is Tampa's 813 with
    // its 1 dropped, or +81 Japan, and nothing in the text says which.
    expect(deriveCountry(lead("8135550123"))).toBe("US");
    expect(deriveCountry(lead("+8135550123"))).toBeNull();
  });

  it("does not let a US state make a foreign number US", () => {
    // Imports fill in a missing state from the phone's first three digits,
    // foreign numbers included until #520: +44 20… got California (442),
    // +65… Alabama (659). Leads already imported keep that state, so a US
    // state beside a foreign number may be the same misreading.
    expect(deriveCountry(lead("+44 20 7946 0958", "CA"))).toBeNull();
    expect(deriveCountry(lead("+65 9234 5678", "AL"))).toBeNull();
  });

  it("still lets a Canadian province say Canada", () => {
    // Unchanged on purpose: that backfill only ever gives a US state, so a
    // province on the lead came from the lead's own data, not its phone.
    expect(deriveCountry(lead("+44 20 7946 0958", "ON"))).toBe("CA");
  });
});

describe("the COUNTRY cell uploaded to Meta", () => {
  const COUNTRY = META_SCHEMA.indexOf("COUNTRY");
  const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

  it("is empty for a foreign number rather than a guessed country", () => {
    // The same three digits, two countries: +1 354 is Quebec, +354 Iceland.
    expect(leadToHashedRow(lead("+1 354 555 0123"))[COUNTRY]).toBe(
      sha256("ca"),
    );
    expect(leadToHashedRow(lead("+354 611 1234"))[COUNTRY]).toBe("");
  });
});
