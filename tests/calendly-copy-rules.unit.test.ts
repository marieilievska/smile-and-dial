import { describe, expect, it } from "vitest";

import {
  COPY_FALLBACK_MS,
  COPY_FRESH_MS,
  COPY_USABLE_MS,
  copyAgeSeconds,
  copyFreshness,
  needsWarm,
  offerableSlots,
  parseSlotList,
  SLOT_MIN_LEAD_MS,
  WARM_AFTER_MS,
} from "../src/lib/calendly/copy-rules";

const NOW = Date.parse("2026-09-14T15:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("copyFreshness", () => {
  it("is fresh inside the fresh window and usable just past it", () => {
    expect(copyFreshness(ago(0), NOW)).toBe("fresh");
    expect(copyFreshness(ago(COPY_FRESH_MS), NOW)).toBe("fresh");
    expect(copyFreshness(ago(COPY_FRESH_MS + 1), NOW)).toBe("usable");
    expect(copyFreshness(ago(COPY_USABLE_MS), NOW)).toBe("usable");
  });

  it("is fallback-only past the usable window, and expired past the fallback one", () => {
    expect(copyFreshness(ago(COPY_USABLE_MS + 1), NOW)).toBe("fallback_only");
    expect(copyFreshness(ago(COPY_FALLBACK_MS), NOW)).toBe("fallback_only");
    expect(copyFreshness(ago(COPY_FALLBACK_MS + 1), NOW)).toBe("expired");
  });

  it("treats a missing or unreadable timestamp as expired", () => {
    expect(copyFreshness(null, NOW)).toBe("expired");
    expect(copyFreshness(undefined, NOW)).toBe("expired");
    expect(copyFreshness("not a date", NOW)).toBe("expired");
  });

  it("treats a copy stamped slightly in the future as fresh (clock skew)", () => {
    expect(copyFreshness(new Date(NOW + 30_000).toISOString(), NOW)).toBe(
      "fresh",
    );
  });
});

describe("copyAgeSeconds", () => {
  it("reports whole seconds, and null when there is no copy", () => {
    expect(copyAgeSeconds(ago(90_000), NOW)).toBe(90);
    expect(copyAgeSeconds(null, NOW)).toBeNull();
  });
});

describe("parseSlotList", () => {
  it("keeps the ISO strings and drops anything else", () => {
    expect(
      parseSlotList([
        "2026-09-14T18:00:00Z",
        42,
        null,
        "not a date",
        "2026-09-15T18:00:00Z",
      ]),
    ).toEqual(["2026-09-14T18:00:00Z", "2026-09-15T18:00:00Z"]);
  });

  it("returns nothing for a null, a string or an object", () => {
    expect(parseSlotList(null)).toEqual([]);
    expect(parseSlotList("2026-09-14T18:00:00Z")).toEqual([]);
    expect(parseSlotList({ slots: [] })).toEqual([]);
  });
});

describe("offerableSlots", () => {
  it("drops what has passed and what starts too soon to join, and sorts the rest", () => {
    const soon = new Date(NOW + SLOT_MIN_LEAD_MS - 60_000).toISOString();
    const later = new Date(NOW + 3 * 3600_000).toISOString();
    const tomorrow = new Date(NOW + 27 * 3600_000).toISOString();
    const past = new Date(NOW - 3600_000).toISOString();
    expect(offerableSlots([tomorrow, past, soon, later], NOW)).toEqual([
      later,
      tomorrow,
    ]);
  });

  it("keeps a slot exactly at the lead time", () => {
    const edge = new Date(NOW + SLOT_MIN_LEAD_MS + 1).toISOString();
    expect(offerableSlots([edge], NOW)).toEqual([edge]);
  });
});

describe("needsWarm", () => {
  it("is true for a copy older than the warm interval, or none at all", () => {
    expect(needsWarm(null, NOW)).toBe(true);
    expect(needsWarm(ago(WARM_AFTER_MS + 1), NOW)).toBe(true);
  });

  it("is false for a copy the dialer refreshed a moment ago", () => {
    expect(needsWarm(ago(WARM_AFTER_MS - 1), NOW)).toBe(false);
  });
});
