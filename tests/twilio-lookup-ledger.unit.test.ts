import { describe, expect, it } from "vitest";

import type { LineType } from "../src/lib/leads/import-fields";
import {
  classifyLookupResponse,
  lineTypesForRows,
  phonesNeedingLookup,
  sanitizeKnownLineTypes,
} from "../src/lib/leads/twilio-lookup";

/**
 * The Twilio Lookup ledger must bill exactly what Twilio bills. Three pure
 * boundaries make that true, and each is pinned here:
 *   - classifyLookupResponse: `billed` is true ONLY for a 2xx answer;
 *   - phonesNeedingLookup: a number is sent to Twilio once per batch, and
 *     never when something already resolved it;
 *   - sanitizeKnownLineTypes: the wizard's memory of earlier passes is
 *     trusted only for definitive types on E.164 keys.
 */

describe("classifyLookupResponse — billed only on a 2xx from Twilio", () => {
  it("2xx with a mobile line type is mobile and billed", () => {
    expect(
      classifyLookupResponse(200, {
        valid: true,
        line_type_intelligence: { type: "mobile" },
      }),
    ).toEqual({ type: "mobile", billed: true });
  });

  it("2xx landline is landline and billed", () => {
    expect(
      classifyLookupResponse(200, {
        valid: true,
        line_type_intelligence: { type: "landline" },
      }),
    ).toEqual({ type: "landline", billed: true });
  });

  it("2xx fixedVoip / nonFixedVoip both map to voip and are billed", () => {
    for (const type of ["fixedVoip", "nonFixedVoip"]) {
      expect(
        classifyLookupResponse(200, { line_type_intelligence: { type } }),
      ).toEqual({ type: "voip", billed: true });
    }
  });

  it("2xx with valid:false is invalid but still billed (Twilio answered)", () => {
    expect(classifyLookupResponse(200, { valid: false })).toEqual({
      type: "invalid",
      billed: true,
    });
  });

  it("2xx with no line type is unknown but billed", () => {
    expect(
      classifyLookupResponse(200, { line_type_intelligence: { type: null } }),
    ).toEqual({ type: "unknown", billed: true });
    expect(classifyLookupResponse(200, null)).toEqual({
      type: "unknown",
      billed: true,
    });
  });

  it("404 (no such number) is invalid and NOT billed", () => {
    expect(classifyLookupResponse(404, { code: 20404 })).toEqual({
      type: "invalid",
      billed: false,
    });
  });

  it("429 rate limit is unknown and NOT billed", () => {
    expect(classifyLookupResponse(429, { code: 20429 })).toEqual({
      type: "unknown",
      billed: false,
    });
  });

  it("5xx and auth failures are unknown and NOT billed", () => {
    for (const status of [401, 403, 500, 502, 503]) {
      expect(classifyLookupResponse(status, null)).toEqual({
        type: "unknown",
        billed: false,
      });
    }
  });
});

describe("phonesNeedingLookup — once per number, never for a known one", () => {
  const none = new Map<string, LineType>();

  it("collapses a number repeated in the file to a single lookup", () => {
    expect(
      phonesNeedingLookup(
        ["+12055550100", "+12055550100", "+12055550101", "+12055550100"],
        none,
      ),
    ).toEqual(["+12055550100", "+12055550101"]);
  });

  it("drops rows with no parseable phone", () => {
    expect(phonesNeedingLookup([null, "+12055550100", null], none)).toEqual([
      "+12055550100",
    ]);
  });

  it("skips numbers already resolved — including ones resolved as unknown", () => {
    const known = new Map<string, LineType>([
      ["+12055550100", "landline"],
      ["+12055550101", "unknown"],
    ]);
    expect(
      phonesNeedingLookup(
        ["+12055550100", "+12055550101", "+12055550102"],
        known,
      ),
    ).toEqual(["+12055550102"]);
  });

  it("keeps first-appearance order", () => {
    expect(
      phonesNeedingLookup(
        ["+12055550102", "+12055550100", "+12055550101"],
        none,
      ),
    ).toEqual(["+12055550102", "+12055550100", "+12055550101"]);
  });

  it("returns nothing when everything is known", () => {
    const known = new Map<string, LineType>([["+12055550100", "mobile"]]);
    expect(
      phonesNeedingLookup(["+12055550100", "+12055550100"], known),
    ).toEqual([]);
  });
});

describe("lineTypesForRows — rows stay aligned to the file", () => {
  it("maps every occurrence of a phone to its one resolved type", () => {
    const resolved = new Map<string, LineType>([
      ["+12055550100", "mobile"],
      ["+12055550101", "landline"],
    ]);
    expect(
      lineTypesForRows(
        ["+12055550100", null, "+12055550101", "+12055550100", "+12055550199"],
        resolved,
      ),
    ).toEqual(["mobile", "unknown", "landline", "mobile", "unknown"]);
  });
});

describe("sanitizeKnownLineTypes — the wizard's memory is trusted narrowly", () => {
  it("keeps definitive types on E.164 US/CA keys", () => {
    const m = sanitizeKnownLineTypes({
      "+12055550100": "mobile",
      "+12055550101": "landline",
      "+12055550102": "voip",
      "+12055550103": "invalid",
    });
    expect([...m.entries()]).toEqual([
      ["+12055550100", "mobile"],
      ["+12055550101", "landline"],
      ["+12055550102", "voip"],
      ["+12055550103", "invalid"],
    ]);
  });

  it("drops unknown so an unresolved number is still looked up", () => {
    expect(sanitizeKnownLineTypes({ "+12055550100": "unknown" }).size).toBe(0);
  });

  it("drops junk values and non-E.164 keys", () => {
    const m = sanitizeKnownLineTypes({
      "+12055550100": "cellphone",
      "2055550101": "mobile",
      "+442071234567": "landline",
      "+12055550102": 42,
    });
    expect(m.size).toBe(0);
  });

  it("tolerates a missing record", () => {
    expect(sanitizeKnownLineTypes(undefined).size).toBe(0);
    expect(sanitizeKnownLineTypes(null).size).toBe(0);
  });
});
