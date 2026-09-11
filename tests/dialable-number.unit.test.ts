import { describe, expect, it } from "vitest";

import { isDialableNumber } from "@/lib/dialer/dialable-number";

/**
 * The dial-time number gate. ElevenLabs is handed a lead's stored number
 * verbatim as `to_number`, so this decides what the AI dialer will ever call.
 *
 * Only "+1" and exactly ten ASCII digits pass: the E.164 form every US/Canada
 * number is stored in (toE164UsCa at import, updateLeadField on edit). Anything
 * else is refused, not repaired. The dialer can't know what a malformed value
 * was meant to be, and a wrong guess dials a stranger.
 */

describe("isDialableNumber — +1 and ten digits, exactly as stored", () => {
  it.each([
    ["a US number", "+12052598928"],
    ["a Canadian number", "+14165550123"],
  ])("%s (%s) is dialable", (_what, phone) => {
    expect(isDialableNumber(phone)).toBe(true);
  });
});

describe("isDialableNumber — a country code other than +1 is never dialed", () => {
  it.each([
    ["the UK", "+442079460958"],
    // Ten digits with its country code: the length of a bare US number.
    ["Singapore", "+6592345678"],
    ["Japan", "+81312345678"],
    // What the CSV import stores when toE164UsCa says "not US": the raw text.
    ["Iceland, as an import keeps it", "+354 611 1234"],
  ])("%s (%s) is not dialable", (_country, phone) => {
    expect(isDialableNumber(phone)).toBe(false);
  });
});

describe("isDialableNumber — anything not already E.164 is refused", () => {
  it.each([
    // The shape of the one non-E.164 lead in production on 2026-09-11: an
    // inbound caller whose caller ID was a word, not a number.
    ["a caller-ID placeholder", "anonymous"],
    ["an empty string", ""],
    // Real US numbers, but not in the stored form. The import and the lead
    // editor normalize; the dialer refuses rather than guessing.
    ["a US number in pretty format", "(205) 259-8928"],
    ["a US number without its +1", "2052598928"],
    ["a US number with its 1 but no +", "12052598928"],
    ["+1 with spaces", "+1 205 259 8928"],
    ["a leading space", " +12052598928"],
    ["a trailing newline", "+12052598928\n"],
    ["an extension", "+12052598928 x12"],
    ["eleven digits after +1", "+120525989281"],
    ["nine digits after +1", "+1205259892"],
    // Look-alikes of "+" and the digits. Only ASCII is dialable.
    ["a full-width plus", "＋12052598928"],
    ["full-width digits", "+1２０５２５９８９２８"],
  ])("%s (%j) is not dialable", (_what, phone) => {
    expect(isDialableNumber(phone)).toBe(false);
  });

  it("no number at all is not dialable", () => {
    expect(isDialableNumber(null)).toBe(false);
    expect(isDialableNumber(undefined)).toBe(false);
  });
});
