import { test, expect } from "@playwright/test";

import {
  bestHourForDay,
  DEFAULT_HOUR_SCORES,
  localDowHour,
  pickNextBestWindow,
  scoreForSlot,
  type ConnectHeatmap,
} from "../src/lib/dialer/best-time";

/** Build an empty 7×24 heatmap for hand-crafting test fixtures. */
function emptyHeatmap(): ConnectHeatmap {
  return Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => ({ dialed: 0, answered: 0, rate: 0 })),
  );
}

test("scoreForSlot returns the empirical rate once samples >= minSamples", () => {
  const heatmap = emptyHeatmap();
  // Tuesday (2) at 10:00 with plenty of samples and a 60% connect rate.
  heatmap[2][10] = { dialed: 20, answered: 12, rate: 0.6 };

  expect(scoreForSlot(heatmap, 2, 10)).toBeCloseTo(0.6, 6);
  // A custom higher threshold the bucket still clears.
  expect(scoreForSlot(heatmap, 2, 10, 15)).toBeCloseTo(0.6, 6);
});

test("scoreForSlot falls back to the prior when samples are below minSamples", () => {
  const heatmap = emptyHeatmap();
  // Only 3 dials — too noisy, even though the rate looks great.
  heatmap[2][10] = { dialed: 3, answered: 3, rate: 1 };

  // Default minSamples (8) is not met → prior for hour 10.
  expect(scoreForSlot(heatmap, 2, 10)).toBe(DEFAULT_HOUR_SCORES[10]);
  // A wholly empty bucket also returns the prior for its hour.
  expect(scoreForSlot(heatmap, 4, 15)).toBe(DEFAULT_HOUR_SCORES[15]);
  // An out-of-calling-hours empty slot scores ~0 via the prior.
  expect(scoreForSlot(heatmap, 4, 3)).toBe(DEFAULT_HOUR_SCORES[3]);
});

test("pickNextBestWindow returns a UTC ISO whose local hour is the favored hour, in-hours and far enough out", () => {
  const tz = "America/New_York";
  const heatmap = emptyHeatmap();

  // Strongly favor 15:00 (3pm) on every day of the week with a near-perfect,
  // well-sampled connect rate so it beats the prior at every other hour.
  for (let day = 0; day < 7; day++) {
    heatmap[day][15] = { dialed: 50, answered: 49, rate: 0.98 };
  }

  // Fixed "now": 2026-06-15T12:00:00Z = 8:00am ET (EDT, UTC-4).
  const nowMs = Date.parse("2026-06-15T12:00:00Z");
  const minHoursOut = 1;

  const iso = pickNextBestWindow({
    heatmap,
    timeZone: tz,
    callingHoursStart: "09:00:00",
    callingHoursEnd: "18:00:00",
    nowMs,
    minHoursOut,
  });

  const chosen = new Date(iso);
  const chosenMs = chosen.getTime();

  // It is a valid, parseable ISO instant.
  expect(Number.isNaN(chosenMs)).toBe(false);
  // It is at least minHoursOut into the future.
  expect(chosenMs).toBeGreaterThanOrEqual(nowMs + minHoursOut * 60 * 60 * 1000);

  // Converted back to the lead's timezone, it lands on the favored hour (15)…
  const { hour, dayOfWeek } = localDowHour(chosen, tz);
  expect(hour).toBe(15);
  // …and within the calling window [9, 18).
  expect(hour).toBeGreaterThanOrEqual(9);
  expect(hour).toBeLessThan(18);
  expect(dayOfWeek).toBeGreaterThanOrEqual(0);
  expect(dayOfWeek).toBeLessThan(7);

  // Tie-break on soonest: with every day's 3pm equally favored, it should pick
  // TODAY's 3pm ET (since now is 8am ET, today's 3pm is still ahead and is the
  // soonest favored slot). 2026-06-15 15:00 EDT = 19:00 UTC.
  expect(iso).toBe("2026-06-15T19:00:00.000Z");
});

test("pickNextBestWindow skips slots inside the minHoursOut guard", () => {
  const tz = "America/New_York";
  const heatmap = emptyHeatmap();
  // Favor 9:00 (the very first calling hour) every day.
  for (let day = 0; day < 7; day++) {
    heatmap[day][9] = { dialed: 40, answered: 36, rate: 0.9 };
  }

  // Now = 2026-06-15T12:30:00Z = 8:30am ET. With minHoursOut = 1, the guard is
  // 9:30am ET, so TODAY's 9:00 ET slot (already past the guard's start) is
  // skipped and the picker rolls to TOMORROW's 9:00 ET.
  const nowMs = Date.parse("2026-06-15T12:30:00Z");
  const iso = pickNextBestWindow({
    heatmap,
    timeZone: tz,
    callingHoursStart: "09:00:00",
    callingHoursEnd: "18:00:00",
    nowMs,
    minHoursOut: 1,
  });

  const chosen = new Date(iso);
  const { hour } = localDowHour(chosen, tz);
  expect(hour).toBe(9);
  // Must be strictly after the 9:30am ET guard.
  expect(chosen.getTime()).toBeGreaterThanOrEqual(nowMs + 60 * 60 * 1000);
  // Tomorrow's 9am EDT = 2026-06-16 13:00 UTC.
  expect(iso).toBe("2026-06-16T13:00:00.000Z");
});

test("bestHourForDay returns the highest-scoring hour within the calling window", () => {
  const heatmap = emptyHeatmap();
  // Strongly favor 14:00 (2pm) on Wednesday (dayOfWeek 3) with a well-sampled,
  // near-perfect connect rate so it beats the cold-start prior at every other
  // in-window hour.
  heatmap[3][14] = { dialed: 40, answered: 38, rate: 0.95 };

  // Within [9, 17) the picker should land on 14.
  expect(bestHourForDay(heatmap, 3, 9, 17)).toBe(14);

  // A degenerate (empty) range returns null so callers fall back to default.
  expect(bestHourForDay(heatmap, 3, 17, 17)).toBeNull();
});
