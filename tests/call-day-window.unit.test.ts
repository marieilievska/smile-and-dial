import { describe, expect, it } from "vitest";

import { computeDailyKpis, sinceDaysAgoIso } from "@/lib/agent-analytics/stats";
import {
  etDateDaysAgo,
  etDayFilterBounds,
  etMidnightUtcIso,
} from "@/lib/time/eastern";

/** Every "calls" number in the app counts `calls` rows by `created_at` inside
 *  an EASTERN calendar day. These guard the three places that used to drift:
 *  the Reporting window start (a rolling 30×24h instant), the Reporting day
 *  bucket (started_at), and the Calls-list date filter (bare UTC strings). */
describe("call-day windows are Eastern and keyed on created_at", () => {
  it("sinceDaysAgoIso starts at ET midnight N days ago, not a rolling instant", () => {
    const iso = sinceDaysAgoIso(30);
    expect(iso).toBe(etMidnightUtcIso(etDateDaysAgo(30)));
    // ET midnight is 04:00Z (EDT) or 05:00Z (EST) — never an arbitrary minute.
    expect(iso).toMatch(/T0[45]:00:00\.000Z$/);
  });

  it("computeDailyKpis buckets by the row's created_at ET day", () => {
    const daily = computeDailyKpis([
      // 11:30pm ET on Sep 2 = 03:30Z Sep 3 — must land on the ET day, Sep 2.
      {
        created_at: "2026-09-03T03:30:00Z",
        outcome: "voicemail",
        duration_seconds: 5,
        extracted_data: {},
        lead_id: "a",
      },
      {
        created_at: "2026-09-03T12:00:00Z",
        outcome: "gatekeeper",
        duration_seconds: 40,
        extracted_data: {},
        lead_id: "b",
      },
    ]);
    expect(daily.map((d) => [d.day, d.callsMade])).toEqual([
      ["2026-09-03", 1],
      ["2026-09-02", 1],
    ]);
  });

  it("etDayFilterBounds turns YYYY-MM-DD from/to into ET day boundaries", () => {
    const b = etDayFilterBounds("2026-09-03", "2026-09-03");
    expect(b.gte).toBe("2026-09-03T04:00:00.000Z");
    // Inclusive end = next ET midnight − 1ms.
    expect(b.lte).toBe("2026-09-04T03:59:59.999Z");
  });

  it("etDayFilterBounds ignores blanks and malformed dates", () => {
    expect(etDayFilterBounds("", "")).toEqual({});
    expect(etDayFilterBounds("2026-9-3", "nope")).toEqual({});
    expect(etDayFilterBounds("2026-09-01", "")).toEqual({
      gte: "2026-09-01T04:00:00.000Z",
    });
  });
});
