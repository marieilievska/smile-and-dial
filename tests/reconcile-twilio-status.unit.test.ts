import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  reconcileCallStatuses,
  type ReconcileOptions,
} from "@/lib/calls/reconcile-twilio-status";
import {
  STATUS_TO_OUTCOME,
  TWILIO_TO_DB_STATUS,
} from "@/lib/twilio/status-webhook";

import { makeFakeDb } from "./helpers/fake-supabase";

/**
 * The bug these guard (prod, 2026-09-08).
 *
 * Every Twilio number's StatusCallback points at ElevenLabs, not at us, so
 * `processTwilioStatus` — which maps busy -> busy and no-answer -> no_answer
 * correctly — never runs for an outbound call. Outcomes arrive from ElevenLabs
 * instead, and ElevenLabs flattens everything that did not connect into
 * `failed`. Checked against Twilio's own records, of 84 calls we had marked
 * status='failed': 47 failed, 22 no-answer, 15 busy. The funnel called 37
 * ordinary dialing outcomes failures, and because pre_call_check counts the day
 * with `status <> 'failed'`, none of them spent anything against
 * calls_per_day_cap.
 *
 * The reconciler asks Twilio afterwards. What matters is that it uses the map
 * that already existed rather than a second copy of it, that it only ever
 * touches rows it is allowed to, and that it is safe to run every 15 minutes
 * forever.
 */

const OLD_SID = process.env.TWILIO_ACCOUNT_SID;
const OLD_TOKEN = process.env.TWILIO_AUTH_TOKEN;

const NOW = new Date("2026-09-08T20:00:00.000Z");
const RECENT = "2026-09-08T19:30:00.000Z";

beforeEach(() => {
  process.env.TWILIO_ACCOUNT_SID = "ACtest";
  process.env.TWILIO_AUTH_TOKEN = "token-test";
});

afterEach(() => {
  process.env.TWILIO_ACCOUNT_SID = OLD_SID;
  process.env.TWILIO_AUTH_TOKEN = OLD_TOKEN;
  vi.unstubAllGlobals();
});

type Row = Record<string, unknown>;

/** One `calls` row as it looks after ElevenLabs called everything a failure. */
function failedCall(over: Row = {}): Row {
  return {
    id: "call-1",
    status: "failed",
    outcome: "failed",
    outcome_source: "elevenlabs",
    twilio_call_sid: "CA1111",
    created_at: RECENT,
    ...over,
  };
}

/**
 * Twilio's Calls resource, faked. `bySid` maps a CallSid to either the status
 * Twilio reports or an HTTP status to fail with. Every request is recorded so a
 * test can assert we did not ask twice.
 */
function stubTwilio(bySid: Record<string, string | { httpStatus: number }>) {
  const requests: string[] = [];
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    requests.push(url);
    const sid = /\/Calls\/([^/.]+)\.json/.exec(url)?.[1] ?? "";
    const entry = bySid[sid];
    if (entry === undefined) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    if (typeof entry === "object") {
      return { ok: false, status: entry.httpStatus, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({ status: entry }) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return { requests };
}

/**
 * The fake Supabase client, wrapped so every `.update()` is recorded. Asserting
 * on the resulting ROW proves the data is right; asserting on this proves we
 * did not issue a pointless write at all — which is the difference between a
 * quiet reconciler and one that rewrites 47 unchanged rows every 15 minutes.
 */
type Builder = Record<string, unknown>;
function recordingDb(seed: Record<string, Row[]>) {
  const db = makeFakeDb(seed);
  const updates: Array<{ table: string; patch: Row }> = [];
  const inner = db.client as unknown as { from: (t: string) => Builder };
  const client = {
    from(table: string) {
      const builder = inner.from(table);
      return new Proxy(builder, {
        get(target: Builder, prop: string | symbol) {
          if (prop === "update") {
            return (patch: Row) => {
              updates.push({ table, patch });
              return (target.update as (p: Row) => unknown)(patch);
            };
          }
          return target[prop as string];
        },
      });
    },
  };
  return { tables: db.tables, updates, client: client as never };
}

function run(
  db: ReturnType<typeof recordingDb>,
  opts: ReconcileOptions = {},
): ReturnType<typeof reconcileCallStatuses> {
  return reconcileCallStatuses(db.client, { now: NOW, ...opts });
}

describe("a Twilio no-answer stops reading as a failure", () => {
  it("relabels status and outcome from the shared map", async () => {
    const db = recordingDb({ calls: [failedCall()] });
    stubTwilio({ CA1111: "no-answer" });

    const summary = await run(db);

    expect(summary).toEqual({
      checked: 1,
      updated: 1,
      byStatus: { "no-answer": 1 },
      errors: 0,
    });
    const row = db.tables.calls[0];
    // Not hardcoded: these ARE the shared map's answers.
    expect(row.status).toBe(TWILIO_TO_DB_STATUS["no-answer"]);
    expect(row.outcome).toBe(STATUS_TO_OUTCOME["no-answer"]);
    expect(row.status).toBe("completed");
    expect(row.outcome).toBe("no_answer");
    // Twilio is now the authority for this row.
    expect(row.outcome_source).toBe("twilio");
  });
});

describe("a Twilio busy stops reading as a failure", () => {
  it("relabels status and outcome from the shared map", async () => {
    const db = recordingDb({ calls: [failedCall()] });
    stubTwilio({ CA1111: "busy" });

    const summary = await run(db);

    expect(summary).toEqual({
      checked: 1,
      updated: 1,
      byStatus: { busy: 1 },
      errors: 0,
    });
    const row = db.tables.calls[0];
    expect(row.status).toBe(TWILIO_TO_DB_STATUS.busy);
    expect(row.outcome).toBe(STATUS_TO_OUTCOME.busy);
    expect(row.status).toBe("completed");
    expect(row.outcome).toBe("busy");
    expect(row.outcome_source).toBe("twilio");
  });
});

describe("a call Twilio also calls failed is left alone", () => {
  it("issues no write at all", async () => {
    const db = recordingDb({ calls: [failedCall()] });
    stubTwilio({ CA1111: "failed" });

    const summary = await run(db);

    expect(summary).toEqual({
      checked: 1,
      updated: 0,
      // Counted, so a dry run can report the whole 47/22/15 split — but not
      // written.
      byStatus: { failed: 1 },
      errors: 0,
    });
    expect(db.updates).toEqual([]);
    expect(db.tables.calls[0]).toMatchObject({
      status: "failed",
      outcome: "failed",
      outcome_source: "elevenlabs",
    });
  });
});

describe("rows the reconciler must not touch", () => {
  it("skips a call with no twilio_call_sid", async () => {
    const db = recordingDb({
      calls: [failedCall({ twilio_call_sid: null })],
    });
    const twilio = stubTwilio({});

    const summary = await run(db);

    expect(summary).toEqual({
      checked: 0,
      updated: 0,
      byStatus: {},
      errors: 0,
    });
    expect(twilio.requests).toEqual([]);
    expect(db.updates).toEqual([]);
  });

  it("skips a status='failed' row whose outcome already says more", async () => {
    // The select narrows to status='failed', but the guard is asserted in code.
    // A row that says goal_met knows something Twilio's CallStatus cannot.
    const db = recordingDb({
      calls: [failedCall({ outcome: "goal_met" })],
    });
    const twilio = stubTwilio({ CA1111: "no-answer" });

    const summary = await run(db);

    expect(summary.checked).toBe(0);
    expect(twilio.requests).toEqual([]);
    expect(db.updates).toEqual([]);
    expect(db.tables.calls[0].outcome).toBe("goal_met");
  });

  it("leaves a call Twilio still has in flight", async () => {
    const db = recordingDb({ calls: [failedCall()] });
    stubTwilio({ CA1111: "in-progress" });

    const summary = await run(db);

    expect(summary).toEqual({
      checked: 1,
      updated: 0,
      byStatus: { "in-progress": 1 },
      errors: 0,
    });
    expect(db.updates).toEqual([]);
  });

  it("ignores calls older than the window", async () => {
    const db = recordingDb({
      calls: [failedCall({ created_at: "2026-09-01T00:00:00.000Z" })],
    });
    const twilio = stubTwilio({ CA1111: "busy" });

    const summary = await run(db, { sinceHours: 48 });

    expect(summary.checked).toBe(0);
    expect(twilio.requests).toEqual([]);
  });
});

describe("a Twilio API error", () => {
  it("counts an error and writes nothing", async () => {
    const db = recordingDb({ calls: [failedCall()] });
    stubTwilio({ CA1111: { httpStatus: 500 } });

    const summary = await run(db);

    expect(summary).toEqual({
      checked: 1,
      updated: 0,
      byStatus: {},
      errors: 1,
    });
    expect(db.updates).toEqual([]);
    expect(db.tables.calls[0].status).toBe("failed");
  });

  it("does not let one bad lookup stop the rest of the run", async () => {
    const db = recordingDb({
      calls: [
        failedCall({ id: "a", twilio_call_sid: "CAa", created_at: RECENT }),
        failedCall({
          id: "b",
          twilio_call_sid: "CAb",
          created_at: "2026-09-08T19:29:00.000Z",
        }),
      ],
    });
    stubTwilio({ CAa: { httpStatus: 429 }, CAb: "no-answer" });

    const summary = await run(db);

    expect(summary).toEqual({
      checked: 2,
      updated: 1,
      byStatus: { "no-answer": 1 },
      errors: 1,
    });
    expect(db.tables.calls.find((r) => r.id === "b")?.outcome).toBe(
      "no_answer",
    );
  });
});

describe("dryRun", () => {
  it("reports the split and writes nothing", async () => {
    const db = recordingDb({
      calls: [
        failedCall({ id: "a", twilio_call_sid: "CAa", created_at: RECENT }),
        failedCall({
          id: "b",
          twilio_call_sid: "CAb",
          created_at: "2026-09-08T19:29:00.000Z",
        }),
        failedCall({
          id: "c",
          twilio_call_sid: "CAc",
          created_at: "2026-09-08T19:28:00.000Z",
        }),
      ],
    });
    stubTwilio({ CAa: "no-answer", CAb: "busy", CAc: "failed" });

    const summary = await run(db, { dryRun: true });

    expect(summary).toEqual({
      checked: 3,
      updated: 2,
      byStatus: { "no-answer": 1, busy: 1, failed: 1 },
      errors: 0,
    });
    expect(db.updates).toEqual([]);
    expect(db.tables.calls.every((r) => r.status === "failed")).toBe(true);
  });
});

describe("running it again", () => {
  it("is idempotent — the second run has nothing left to see", async () => {
    const db = recordingDb({ calls: [failedCall()] });
    const twilio = stubTwilio({ CA1111: "no-answer" });

    const first = await run(db);
    expect(first.updated).toBe(1);
    expect(db.updates).toHaveLength(1);

    const second = await run(db);

    expect(second).toEqual({
      checked: 0,
      updated: 0,
      byStatus: {},
      errors: 0,
    });
    // The row left the working set the moment it was relabelled, so the second
    // run doesn't even reach Twilio for it.
    expect(twilio.requests).toHaveLength(1);
    expect(db.updates).toHaveLength(1);
    expect(db.tables.calls[0].outcome).toBe("no_answer");
  });
});

describe("missing Twilio credentials", () => {
  it("reports an error instead of a clean run over nothing", async () => {
    delete process.env.TWILIO_ACCOUNT_SID;
    const db = recordingDb({ calls: [failedCall()] });
    const twilio = stubTwilio({ CA1111: "busy" });

    const summary = await run(db);

    expect(summary.errors).toBe(1);
    expect(summary.checked).toBe(0);
    expect(twilio.requests).toEqual([]);
  });
});

/**
 * The whole point of the module: ONE mapping, not two.
 *
 * Read as source text because the failure mode is a person adding a private
 * `const TWILIO_TO_DB = { "no-answer": ... }` here rather than importing the
 * one in status-webhook.ts — which type-checks, passes every behavioural test
 * above, and then drifts the day someone corrects one copy. Comments are
 * stripped so the prose explaining the rule can never satisfy it.
 */
const SRC = readFileSync("src/lib/calls/reconcile-twilio-status.ts", "utf8");
const WEBHOOK = readFileSync("src/lib/twilio/status-webhook.ts", "utf8");

function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("the reconciler shares the status webhook's mapping", () => {
  it("imports both maps from status-webhook.ts", () => {
    const body = code(SRC);
    expect(body).toContain('from "@/lib/twilio/status-webhook"');
    expect(body).toContain("TWILIO_TO_DB_STATUS");
    expect(body).toContain("STATUS_TO_OUTCOME");
  });

  it("keeps them exported there", () => {
    const body = code(WEBHOOK);
    expect(body).toMatch(/export const TWILIO_TO_DB_STATUS/);
    expect(body).toMatch(/export const STATUS_TO_OUTCOME/);
  });

  it("declares no mapping of its own", () => {
    const body = code(SRC);
    // A second map would have to name Twilio's hyphenated statuses or our
    // outcome values somewhere in code. Neither appears — the only literals
    // here are the `failed` status guards.
    expect(body).not.toMatch(/["']no-answer["']/);
    expect(body).not.toMatch(/["']no_answer["']/);
    expect(body).not.toMatch(/["']busy["']/);
    expect(body).not.toMatch(/Record<\s*TwilioCallStatus/);
  });

  it("still maps busy and no-answer the way the webhook always did", () => {
    // If this ever fails, the shared map changed under both callers — which is
    // the point of sharing it, but it should be a deliberate edit.
    expect(TWILIO_TO_DB_STATUS.busy).toBe("completed");
    expect(STATUS_TO_OUTCOME.busy).toBe("busy");
    expect(TWILIO_TO_DB_STATUS["no-answer"]).toBe("completed");
    expect(STATUS_TO_OUTCOME["no-answer"]).toBe("no_answer");
    expect(TWILIO_TO_DB_STATUS.failed).toBe("failed");
    expect(STATUS_TO_OUTCOME.failed).toBe("failed");
  });

  it("does not re-run the retry engine", () => {
    // Deliberate: failed / no_answer / busy share one retry bucket, so there is
    // nothing to re-derive, and reapplyRetryForCall on a lead that has already
    // moved on double-advances its 2d/2d/15d cycle. See RETRY_LADDER in the
    // module.
    const body = code(SRC);
    expect(body).not.toContain("reapplyRetryForCall");
    expect(body).not.toContain("applyRetryForCall");
    expect(body).not.toContain("recomputeLeadCallState");
    // And it writes to nothing but the calls table.
    const tables = [...body.matchAll(/\.from\(\s*["']([a-z_]+)["']/g)].map(
      (m) => m[1],
    );
    expect([...new Set(tables)]).toEqual(["calls"]);
  });
});
