import { describe, expect, test } from "vitest";

import {
  HEARTBEAT_RETENTION_DAYS,
  heartbeatPruneCutoff,
  isDue,
  WEBHOOK_HEALTH_CHECK_INTERVAL_MS,
} from "@/lib/alerts/throttle";

const NOW = new Date("2026-09-05T15:00:00.000Z");
const minutesAgo = (n: number) =>
  new Date(NOW.getTime() - n * 60_000).toISOString();

describe("isDue — the tick's at-most-once-per-interval helper", () => {
  test("never done before is due", () => {
    expect(isDue(null, WEBHOOK_HEALTH_CHECK_INTERVAL_MS, NOW)).toBe(true);
    expect(isDue(undefined, WEBHOOK_HEALTH_CHECK_INTERVAL_MS, NOW)).toBe(true);
    expect(isDue("", WEBHOOK_HEALTH_CHECK_INTERVAL_MS, NOW)).toBe(true);
  });

  test("an unparseable timestamp counts as due, not as 'never again'", () => {
    expect(isDue("not a date", 60_000, NOW)).toBe(true);
  });

  test("inside the interval is not due; at or past it is", () => {
    const tenMin = WEBHOOK_HEALTH_CHECK_INTERVAL_MS;
    expect(isDue(minutesAgo(9), tenMin, NOW)).toBe(false);
    expect(isDue(minutesAgo(10), tenMin, NOW)).toBe(true);
    expect(isDue(minutesAgo(11), tenMin, NOW)).toBe(true);
  });

  test("a timestamp in the future (clock skew) is not due", () => {
    expect(isDue(minutesAgo(-1), 60_000, NOW)).toBe(false);
  });

  test("the webhook check interval is 10 minutes", () => {
    expect(WEBHOOK_HEALTH_CHECK_INTERVAL_MS).toBe(10 * 60 * 1000);
  });
});

describe("heartbeatPruneCutoff", () => {
  test("defaults to 7 days before now", () => {
    expect(HEARTBEAT_RETENTION_DAYS).toBe(7);
    expect(heartbeatPruneCutoff(NOW)).toBe("2026-08-29T15:00:00.000Z");
  });

  test("honours a custom window", () => {
    expect(heartbeatPruneCutoff(NOW, 1)).toBe("2026-09-04T15:00:00.000Z");
  });
});
