import { describe, expect, it } from "vitest";
import { parseLeadLocalDatetime } from "@/lib/dialer/local-schedule";

describe("parseLeadLocalDatetime", () => {
  it("reads the wall clock in the lead's zone and ignores the model's offset", () => {
    // Hi Rollers (Anchorage): the model sent 9:00 with an Eastern offset, which
    // used to store 5 AM Alaska. 9:00 AKDT is 17:00Z.
    expect(
      parseLeadLocalDatetime(
        "2026-10-02T09:00:00-04:00",
        "America/Anchorage",
      )?.toISOString(),
    ).toBe("2026-10-02T17:00:00.000Z");
    // Honolulu, "tomorrow morning" = 10:00 HST = 20:00Z.
    expect(
      parseLeadLocalDatetime(
        "2026-09-03T10:00:00-04:00",
        "Pacific/Honolulu",
      )?.toISOString(),
    ).toBe("2026-09-03T20:00:00.000Z");
  });

  it("is unchanged when the model's offset was already the lead's", () => {
    expect(
      parseLeadLocalDatetime(
        "2026-09-03T10:00:00-10:00",
        "Pacific/Honolulu",
      )?.toISOString(),
    ).toBe("2026-09-03T20:00:00.000Z");
    expect(
      parseLeadLocalDatetime(
        "2026-09-03T10:00",
        "Pacific/Honolulu",
      )?.toISOString(),
    ).toBe("2026-09-03T20:00:00.000Z");
  });

  it("handles standard time and Eastern leads", () => {
    expect(
      parseLeadLocalDatetime(
        "2027-01-15T09:00:00-05:00",
        "America/Los_Angeles",
      )?.toISOString(),
    ).toBe("2027-01-15T17:00:00.000Z");
    expect(
      parseLeadLocalDatetime(
        "2026-09-04T10:00:00-04:00",
        "America/New_York",
      )?.toISOString(),
    ).toBe("2026-09-04T14:00:00.000Z");
  });

  it("returns null for blank or unparseable input", () => {
    expect(parseLeadLocalDatetime("", "America/New_York")).toBeNull();
    expect(parseLeadLocalDatetime(null, "America/New_York")).toBeNull();
    expect(parseLeadLocalDatetime("whenever", "America/New_York")).toBeNull();
  });
});
