import { describe, expect, test } from "vitest";

import {
  evaluateWebhookHealth,
  WEBHOOK_FAILURE_WINDOW_MS,
  type WorkspaceWebhook,
} from "@/lib/alerts/webhook-health";

const NOW = new Date("2026-09-05T15:30:00.000Z");
const nowSec = Math.floor(NOW.getTime() / 1000);
const OURS = "f14b67abc";

function hook(over: Partial<WorkspaceWebhook> = {}): WorkspaceWebhook {
  // Mirrors the live GET /v1/workspace/webhooks shape (2026-09-05).
  return {
    webhook_id: OURS,
    name: "Smile & Dial Post-Call",
    is_disabled: false,
    is_auto_disabled: false,
    most_recent_failure_error_code: null,
    most_recent_failure_timestamp: null,
    ...over,
  };
}

describe("evaluateWebhookHealth", () => {
  test("healthy webhook: ok, nothing to alert", () => {
    const h = evaluateWebhookHealth([hook()], OURS, NOW);
    expect(h.status).toBe("ok");
    expect(h.alert).toBe(false);
    expect(h.critical).toBe(false);
    expect(h.message).toBeNull();
  });

  test("a failure inside the last hour is 'failing' (warning, not critical)", () => {
    const h = evaluateWebhookHealth(
      [
        hook({
          most_recent_failure_error_code: 413,
          most_recent_failure_timestamp: nowSec - 12 * 60,
        }),
      ],
      OURS,
      NOW,
    );
    expect(h.status).toBe("failing");
    expect(h.alert).toBe(true);
    expect(h.critical).toBe(false);
    expect(h.failureCode).toBe(413);
    expect(h.failureAgeMinutes).toBe(12);
    expect(h.message).toContain("12 minutes ago");
    expect(h.message).toContain("HTTP 413");
    expect(h.message).toContain("auto-disable");
  });

  test("a failure older than the window is stale: ok, code still reported", () => {
    const h = evaluateWebhookHealth(
      [
        hook({
          most_recent_failure_error_code: 500,
          most_recent_failure_timestamp:
            nowSec - WEBHOOK_FAILURE_WINDOW_MS / 1000 - 1,
        }),
      ],
      OURS,
      NOW,
    );
    expect(h.status).toBe("ok");
    expect(h.alert).toBe(false);
    expect(h.failureCode).toBe(500);
  });

  test("exactly at the window edge is no longer failing", () => {
    const h = evaluateWebhookHealth(
      [
        hook({
          most_recent_failure_timestamp:
            nowSec - WEBHOOK_FAILURE_WINDOW_MS / 1000,
        }),
      ],
      OURS,
      NOW,
    );
    expect(h.status).toBe("ok");
  });

  test("millisecond timestamps are tolerated", () => {
    const h = evaluateWebhookHealth(
      [hook({ most_recent_failure_timestamp: NOW.getTime() - 5 * 60_000 })],
      OURS,
      NOW,
    );
    expect(h.status).toBe("failing");
    expect(h.failureAgeMinutes).toBe(5);
  });

  test("auto-disabled is critical and says so, whatever the failure age", () => {
    const h = evaluateWebhookHealth(
      [
        hook({
          is_auto_disabled: true,
          most_recent_failure_error_code: 502,
          most_recent_failure_timestamp: nowSec - 3 * 24 * 3600,
        }),
      ],
      OURS,
      NOW,
    );
    expect(h.status).toBe("auto_disabled");
    expect(h.alert).toBe(true);
    expect(h.critical).toBe(true);
    expect(h.message).toMatch(/auto-disabled/);
    expect(h.message).toMatch(/critical/);
    expect(h.message).toContain("HTTP 502");
  });

  test("manually disabled is critical too", () => {
    const h = evaluateWebhookHealth([hook({ is_disabled: true })], OURS, NOW);
    expect(h.status).toBe("disabled");
    expect(h.critical).toBe(true);
    expect(h.message).toMatch(/critical/);
  });

  test("auto-disabled outranks disabled when both are set", () => {
    const h = evaluateWebhookHealth(
      [hook({ is_disabled: true, is_auto_disabled: true })],
      OURS,
      NOW,
    );
    expect(h.status).toBe("auto_disabled");
  });

  test("our id absent from the workspace is critical ('missing')", () => {
    const h = evaluateWebhookHealth(
      [hook({ webhook_id: "someone-elses" })],
      OURS,
      NOW,
    );
    expect(h.status).toBe("missing");
    expect(h.critical).toBe(true);
    expect(h.alert).toBe(true);
  });

  test("no configured id: unconfigured, never alerts", () => {
    for (const id of [null, undefined, "", "   "]) {
      const h = evaluateWebhookHealth([hook()], id, NOW);
      expect(h.status).toBe("unconfigured");
      expect(h.alert).toBe(false);
    }
  });

  test("other webhooks in the workspace never affect ours", () => {
    const h = evaluateWebhookHealth(
      [hook({ webhook_id: "other", is_auto_disabled: true }), hook()],
      OURS,
      NOW,
    );
    expect(h.status).toBe("ok");
  });
});
