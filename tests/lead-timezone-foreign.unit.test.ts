// tests/lead-timezone-foreign.unit.test.ts
import { describe, it, expect } from "vitest";
import {
  leadTimezoneFrom,
  phoneToTimezone,
  stateFromPhone,
} from "../src/lib/leads/timezone";
import { toE164UsCa } from "../src/lib/leads/twilio-lookup";

/**
 * A leading "+" says a country code comes next, and every country code but 1
 * is outside the NANP. Reading an area code by counting digits cannot see
 * that, so a foreign number's first three digits passed for a US or Canadian
 * area code, and a CSV with no state column was imported with that state and
 * timezone filled in: a Singapore business arrived as an Alabama lead on
 * Central time.
 *
 * #518 fixed the same flaw in toE164UsCa, which decides the number a lead is
 * stored under. An import reads one phone through both, so these pin the state
 * and timezone to the same rule: a + followed by anything but 1 is foreign.
 */

describe("a country code other than +1 is never read as an area code", () => {
  // [country, number, the area code its leading digits spell, and the state
  // and zone that code would have given the lead]. A null state is a Canadian
  // code, which has a zone but no US state.
  //
  // Each row is load-bearing: the test first proves its digits really spell a
  // code we map, so none can pass by spelling nothing. Between them they reach
  // all three tables a code resolves through: the state map, the split-state
  // overrides (423, 865) and the Canadian codes (354, 902).
  const FOREIGN: [
    country: string,
    phone: string,
    code: string,
    state: string | null,
    zone: string,
  ][] = [
    // Ten digits in total, the length of a bare US number.
    ["Iceland", "+354 611 1234", "354", null, "America/New_York"],
    ["Singapore", "+65 9234 5678", "659", "AL", "America/Chicago"],
    ["Liechtenstein", "+423 235 1234", "423", "TN", "America/New_York"],
    // Eleven, the length of a US number written with its 1.
    ["Australia", "+61 2 9876 5432", "612", "MN", "America/Chicago"],
    ["Japan", "+81 3 1234 5678", "813", "FL", "America/New_York"],
    // Twelve.
    ["the UK", "+44 20 7946 0958", "442", "CA", "America/Los_Angeles"],
    // Same UK number, with the "+" pushed past other characters. Proves the
    // check runs on the [^\d+]-cleaned string, not the raw text — read raw,
    // neither of these starts with "+", so a check on the raw text would miss
    // the country code and fall through to the digit count.
    [
      "the UK, with the + in brackets",
      "(+44) 20 7946 0958",
      "442",
      "CA",
      "America/Los_Angeles",
    ],
    [
      'the UK, after a "Tel:" label',
      "Tel: +44 20 7946 0958",
      "442",
      "CA",
      "America/Los_Angeles",
    ],
    ["Turkey", "+90 212 123 4567", "902", null, "America/Halifax"],
    // Thirteen.
    ["Brazil", "+55 11 91234 5678", "551", "NJ", "America/New_York"],
    ["China", "+86 571 1234 5678", "865", "TN", "America/New_York"],
  ];

  it.each(FOREIGN)(
    "%s %s is not area code %s",
    (_country, phone, code, state, zone) => {
      // The trap is real: read as a bare number, these digits are a code we map.
      expect(phone.replace(/\D/g, "").slice(0, 3)).toBe(code);
      expect(stateFromPhone(`${code}5550123`)).toBe(state);
      expect(phoneToTimezone(`${code}5550123`)).toBe(zone);
      // But the + puts a country code first, so the number carries neither...
      expect(stateFromPhone(phone)).toBeNull();
      expect(phoneToTimezone(phone)).toBeNull();
      // ...which is what toE164UsCa already concludes about storing it.
      expect(toE164UsCa(phone)).toBeNull();
    },
  );

  it("reads a + with no 1 as foreign, even where a US number was meant", () => {
    // The call #518 made for toE164UsCa, made the same way here: "+8135550123"
    // is Tampa's 813 with its 1 dropped, or +81 Japan, and nothing in the text
    // says which. An unplaced lead shows up blank; a wrong guess looks placed.
    expect(stateFromPhone("8135550123")).toBe("FL");
    expect(stateFromPhone("+8135550123")).toBeNull();
    expect(phoneToTimezone("+8135550123")).toBeNull();
    expect(toE164UsCa("+8135550123")).toBeNull();
    // A doubled "+" typo for +1 205 259 8928: the second character isn't 1,
    // so it falls under the same rule and reads as foreign rather than as
    // Alabama — and both parsers still agree.
    expect(stateFromPhone("++1 205 259 8928")).toBeNull();
    expect(phoneToTimezone("++1 205 259 8928")).toBeNull();
    expect(toE164UsCa("++1 205 259 8928")).toBeNull();
  });
});

describe("a US or Canadian number keeps its area code in every format", () => {
  // The import reads the state and timezone off the phone as the CSV wrote it,
  // then stores the number through toE164UsCa, so each format must resolve the
  // same way written as it does stored. Same formats as toE164UsCa's own tests.
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
    // The raw text starts "+ 1", not "+1" — only the cleaned string reads as
    // +1. A check on raw text would see a "+" not immediately followed by 1
    // and wrongly call this foreign, dropping a real Alabama number.
    ["a space after the plus", "+ 1 205 259 8928"],
  ])("%s (%s) is Alabama, on Central", (_format, phone) => {
    expect(stateFromPhone(phone)).toBe("AL");
    expect(phoneToTimezone(phone)).toBe("America/Chicago");
    const stored = toE164UsCa(phone);
    expect(stored).toBe("+12052598928");
    expect(stateFromPhone(stored)).toBe("AL");
    expect(phoneToTimezone(stored)).toBe("America/Chicago");
  });

  it("still reads the area code in front of an extension", () => {
    // Unchanged on purpose. toE164UsCa will not store this, since an extension
    // is not part of the number, but the area code is still plainly 205.
    expect(toE164UsCa("(205) 259-8928 ext. 12")).toBeNull();
    expect(stateFromPhone("(205) 259-8928 ext. 12")).toBe("AL");
    expect(phoneToTimezone("(205) 259-8928 ext. 12")).toBe("America/Chicago");
  });

  it("keeps +1 numbers on the override and Canadian tables", () => {
    expect(stateFromPhone("+1 (915) 555-0123")).toBe("TX");
    expect(phoneToTimezone("+1 (915) 555-0123")).toBe("America/Denver");
    expect(stateFromPhone("+1 (416) 555-0123")).toBeNull();
    expect(phoneToTimezone("+1 (416) 555-0123")).toBe("America/New_York");
    expect(phoneToTimezone("+1 604 555 0123")).toBe("America/Los_Angeles");
  });
});

describe("leadTimezoneFrom: a foreign phone places no one", () => {
  // The import runs this on the raw CSV phone. Through the fake area code, a
  // foreign number reached every branch that reads the phone: the zone itself,
  // the override gate, and the state the city table is keyed by.

  it.each([
    ["Singapore", "+65 9234 5678"],
    ["the UK", "+44 20 7946 0958"],
    ["Iceland", "+354 611 1234"],
    ["Liechtenstein", "+423 235 1234"],
  ])("%s %s with no state has no timezone", (_country, phone) => {
    expect(leadTimezoneFrom({ city: null, state: null, phone })).toBeNull();
  });

  it("does not let a foreign number override a stated state", () => {
    // An override beats the state default only when the phone and the state
    // agree on the state. Liechtenstein's +423 spells east Tennessee's 423, so
    // the fake area code "agreed" with TN and moved the lead to Eastern. A
    // Tennessee lead with this number is just in Tennessee, on its default.
    expect(
      leadTimezoneFrom({ city: null, state: "TN", phone: "+423 235 1234" }),
    ).toBe("America/Chicago");
    // A real 423 still moves it.
    expect(
      leadTimezoneFrom({ city: null, state: "TN", phone: "+1 423 555 0123" }),
    ).toBe("America/New_York");
  });

  it("does not key the city table by a state the phone never gave", () => {
    // Malaysia's +60 5 spells South Dakota's 605, so a CSV with a city but no
    // state column put this lead on the west-river Mountain table.
    expect(
      leadTimezoneFrom({
        city: "Rapid City",
        state: null,
        phone: "+60 5 123 4567",
      }),
    ).toBeNull();
    // A real 605 still does.
    expect(
      leadTimezoneFrom({
        city: "Rapid City",
        state: null,
        phone: "+1 605 555 0123",
      }),
    ).toBe("America/Denver");
  });

  it("still reads a +1 number however the CSV wrote it", () => {
    expect(
      leadTimezoneFrom({ city: null, state: null, phone: "+1 (915) 555-0123" }),
    ).toBe("America/Denver");
    expect(
      leadTimezoneFrom({ city: null, state: "TX", phone: "+1-915-555-0123" }),
    ).toBe("America/Denver");
    expect(
      leadTimezoneFrom({ city: null, state: null, phone: "1 (416) 555-0123" }),
    ).toBe("America/New_York");
  });
});

/** Text as typed on a full-width (CJK) keyboard: each ASCII symbol and digit
 *  becomes its U+FFxx twin, so "+" is "＋" (U+FF0B) and "2" is "２". */
const fullWidth = (s: string) =>
  s.replace(/[!-~]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0xfee0));

describe("full-width characters, read the same way by both parsers", () => {
  it("a full-width plus is a country code, not an area code", () => {
    // "＋65 9234 5678" is Singapore. With the "＋" stripped like any other
    // symbol its digits spell 659, so the lead came in as Alabama on Central.
    expect(stateFromPhone("＋65 9234 5678")).toBeNull();
    expect(phoneToTimezone("＋65 9234 5678")).toBeNull();
    expect(toE164UsCa("＋65 9234 5678")).toBeNull();
  });

  it("full-width digits are still a US number, placed as one", () => {
    // An import stores the number through toE164UsCa and reads its timezone
    // through areaCodeOf. If only the first read full-width digits, the lead
    // would be stored dialable with no timezone, and a blank timezone is
    // gated on Eastern time.
    const phone = fullWidth("(205) 259-8928");
    expect(toE164UsCa(phone)).toBe("+12052598928");
    expect(stateFromPhone(phone)).toBe("AL");
    expect(phoneToTimezone(phone)).toBe("America/Chicago");
  });
});
