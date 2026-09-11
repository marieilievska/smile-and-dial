// tests/foreign-country-code.unit.test.ts
import { describe, expect, it } from "vitest";

import { hasForeignCountryCode } from "../src/lib/leads/foreign-country-code";

/**
 * "A + followed by anything but 1 is a foreign country code" used to live in
 * three inline copies: toE164UsCa (the number a lead is stored and dialed
 * under), areaCodeOf (the state and timezone an import fills in) and
 * deriveCountry (the COUNTRY sent to Meta). Each caller's own tests pin what
 * the rule means for it; these pin the rule itself, now that there is one.
 */

describe("hasForeignCountryCode — a + followed by anything but 1", () => {
  it.each([
    // Ten digits in all, the length of a bare US number.
    ["Iceland", "+354 611 1234"],
    ["Singapore", "+65 9234 5678"],
    ["the UK", "+44 20 7946 0958"],
    ["Japan", "+81 3 1234 5678"],
  ])("%s (%s) is foreign", (_country, phone) => {
    expect(hasForeignCountryCode(phone)).toBe(true);
  });

  it("is foreign even where a US number was meant", () => {
    // Tampa's 813 with its 1 dropped, or +81 Japan: nothing in the text says
    // which, and a rejected typo beats a dialed stranger.
    expect(hasForeignCountryCode("+8135550123")).toBe(true);
    // A doubled "+": the character after the first one isn't 1.
    expect(hasForeignCountryCode("++1 205 259 8928")).toBe(true);
  });

  it.each([
    ["E.164", "+12052598928"],
    ["pretty formatting", "+1 (205) 259-8928"],
    ["Canadian", "+1 416 555 0123"],
  ])("a +1 number (%s, %s) is not foreign", (_format, phone) => {
    expect(hasForeignCountryCode(phone)).toBe(false);
  });
});

describe("hasForeignCountryCode — reads the cleaned string, not the raw text", () => {
  // Everything but digits and "+" is stripped first. Read raw, the first two
  // don't start with their "+", and the third starts "+ " rather than "+1".
  it.each([
    ["(+44) 20 7946 0958", true],
    ["Tel: +44 20 7946 0958", true],
    ["+ 1 205 259 8928", false],
  ])("%s is foreign: %s", (phone, foreign) => {
    expect(hasForeignCountryCode(phone)).toBe(foreign);
  });
});

describe("hasForeignCountryCode — no + means no country code to read", () => {
  it.each([
    ["bare 10 digits", "2052598928"],
    ["11 digits with the leading 1", "12052598928"],
    ["parentheses and a dash", "(205) 259-8928"],
    // A UK number that lost its "+". Only a written code counts; what these
    // digits are is left to each caller's digit count.
    ["a foreign number without its +", "442079460958"],
    ["empty", ""],
  ])("%s (%s) is not foreign", (_format, phone) => {
    expect(hasForeignCountryCode(phone)).toBe(false);
  });

  it("a missing phone is not foreign", () => {
    expect(hasForeignCountryCode(null)).toBe(false);
    expect(hasForeignCountryCode(undefined)).toBe(false);
  });
});
