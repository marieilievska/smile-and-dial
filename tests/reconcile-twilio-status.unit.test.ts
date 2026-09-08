import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEAD_NUMBER_CODES,
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
 *
 * SECOND HALF (this file's later blocks): Twilio's status says a call failed,
 * its error_code says WHY, and only the second question can distinguish a dead
 * number from our own plumbing breaking. A dead number is suppressed to DNC; a
 * geo-permission refusal and a codeless failure are NOT, because both are
 * statements about us and suppressing on them permanently deletes live leads.
 * The tests that assert a NON-suppression are the important ones here.
 */

const OLD_SID = process.env.TWILIO_ACCOUNT_SID;
const OLD_TOKEN = process.env.TWILIO_AUTH_TOKEN;

const NOW = new Date("2026-09-08T20:00:00.000Z");
const RECENT = "2026-09-08T19:30:00.000Z";
/** The +2-day date the ORIGINAL `failed` outcome bought the lead. A suppressed
 *  lead must not keep it. */
const PENDING_RETRY = "2026-09-10T13:00:00.000Z";

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
    twilio_error_code: null,
    lead_id: "lead-1",
    campaign_id: "camp-1",
    created_at: RECENT,
    ...over,
  };
}

/** The lead behind `failedCall`, mid-rotation: still ready, still scheduled. */
function readyLead(over: Row = {}): Row {
  return {
    id: "lead-1",
    business_phone: "+15551230000",
    company: "Bright Smile Dental",
    owner_id: "owner-1",
    timezone: "America/New_York",
    calendly_event_uri: null,
    status: "ready_to_call",
    next_call_at: PENDING_RETRY,
    ...over,
  };
}

/**
 * Twilio's Calls resource, faked. `bySid` maps a CallSid to the status Twilio
 * reports (a bare string, no error code), a status plus an error_code, or an
 * HTTP status to fail with. Every request is recorded so a test can assert we
 * did not ask twice.
 */
type TwilioEntry =
  | string
  | { httpStatus: number }
  | { status: string; errorCode: number | string | null };

function stubTwilio(bySid: Record<string, TwilioEntry>) {
  const requests: string[] = [];
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    requests.push(url);
    const sid = /\/Calls\/([^/.]+)\.json/.exec(url)?.[1] ?? "";
    const entry = bySid[sid];
    if (entry === undefined) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    if (typeof entry === "object" && "httpStatus" in entry) {
      return { ok: false, status: entry.httpStatus, json: async () => ({}) };
    }
    const body =
      typeof entry === "string"
        ? { status: entry, error_code: null }
        : { status: entry.status, error_code: entry.errorCode };
    return { ok: true, status: 200, json: async () => body };
  });
  vi.stubGlobal("fetch", fetchMock);
  return { requests };
}

/**
 * The fake Supabase client, wrapped so every WRITE is recorded with the table
 * it landed on. Asserting on the resulting ROW proves the data is right;
 * asserting on this proves two other things a row cannot: that we did not
 * issue a pointless write at all (the difference between a quiet reconciler
 * and one that rewrites 47 unchanged rows every 15 minutes), and WHICH TABLES
 * a given path is allowed to reach.
 */
type Builder = Record<string, unknown>;
const WRITE_OPS = ["update", "insert", "upsert"] as const;
type WriteOp = (typeof WRITE_OPS)[number];

function recordingDb(seed: Record<string, Row[]>) {
  const db = makeFakeDb(seed);
  const writes: Array<{ table: string; op: WriteOp; patch: Row }> = [];
  const inner = db.client as unknown as { from: (t: string) => Builder };
  const client = {
    from(table: string) {
      const builder = inner.from(table);
      return new Proxy(builder, {
        get(target: Builder, prop: string | symbol) {
          if (WRITE_OPS.includes(prop as WriteOp)) {
            return (patch: Row, ...rest: unknown[]) => {
              writes.push({ table, op: prop as WriteOp, patch });
              return (
                target[prop as string] as (p: Row, ...r: unknown[]) => unknown
              )(patch, ...rest);
            };
          }
          return target[prop as string];
        },
      });
    },
  };
  return {
    tables: db.tables,
    writes,
    /** Back-compat view: only the `.update()` calls. */
    get updates() {
      return writes
        .filter((w) => w.op === "update")
        .map((w) => ({ table: w.table, patch: w.patch }));
    },
    /** Which tables this run wrote to, in first-touch order. */
    get tablesWritten() {
      return [...new Set(writes.map((w) => w.table))];
    },
    client: client as never,
  };
}

function run(
  db: ReturnType<typeof recordingDb>,
  opts: ReconcileOptions = {},
): ReturnType<typeof reconcileCallStatuses> {
  return reconcileCallStatuses(db.client, { now: NOW, ...opts });
}

/** The summary shape, with the fields a given test doesn't care about at their
 *  zero values, so every assertion stays a whole-object comparison. */
function summaryOf(over: Partial<Awaited<ReturnType<typeof run>>> = {}) {
  return {
    checked: 0,
    updated: 0,
    suppressed: 0,
    byStatus: {},
    errorCodes: {},
    errors: 0,
    ...over,
  };
}

describe("a Twilio no-answer stops reading as a failure", () => {
  it("relabels status and outcome from the shared map", async () => {
    const db = recordingDb({ calls: [failedCall()] });
    stubTwilio({ CA1111: "no-answer" });

    const summary = await run(db);

    expect(summary).toEqual(
      summaryOf({
        checked: 1,
        updated: 1,
        byStatus: { "no-answer": 1 },
        errorCodes: { none: 1 },
      }),
    );
    const row = db.tables.calls[0];
    // Not hardcoded: these ARE the shared map's answers.
    expect(row.status).toBe(TWILIO_TO_DB_STATUS["no-answer"]);
    expect(row.outcome).toBe(STATUS_TO_OUTCOME["no-answer"]);
    expect(row.status).toBe("completed");
    expect(row.outcome).toBe("no_answer");
    // Twilio is now the authority for this row.
    expect(row.outcome_source).toBe("twilio");
  });

  it("writes to calls and nothing else", async () => {
    // The #505 guarantee, kept alive now that ONE path is allowed outside
    // `calls`. A no-answer is not that path.
    const db = recordingDb({ calls: [failedCall()], leads: [readyLead()] });
    stubTwilio({ CA1111: "no-answer" });

    await run(db);

    expect(db.tablesWritten).toEqual(["calls"]);
    expect(db.tables.dnc_entries ?? []).toEqual([]);
    expect(db.tables.leads[0]).toMatchObject({
      status: "ready_to_call",
      next_call_at: PENDING_RETRY,
    });
  });
});

describe("a Twilio busy stops reading as a failure", () => {
  it("relabels status and outcome from the shared map", async () => {
    const db = recordingDb({ calls: [failedCall()] });
    stubTwilio({ CA1111: "busy" });

    const summary = await run(db);

    expect(summary).toEqual(
      summaryOf({
        checked: 1,
        updated: 1,
        byStatus: { busy: 1 },
        errorCodes: { none: 1 },
      }),
    );
    const row = db.tables.calls[0];
    expect(row.status).toBe(TWILIO_TO_DB_STATUS.busy);
    expect(row.outcome).toBe(STATUS_TO_OUTCOME.busy);
    expect(row.status).toBe("completed");
    expect(row.outcome).toBe("busy");
    expect(row.outcome_source).toBe("twilio");
  });

  it("writes to calls and nothing else", async () => {
    const db = recordingDb({ calls: [failedCall()], leads: [readyLead()] });
    stubTwilio({ CA1111: "busy" });

    await run(db);

    expect(db.tablesWritten).toEqual(["calls"]);
    expect(db.tables.dnc_entries ?? []).toEqual([]);
    expect(db.tables.leads[0]).toMatchObject({ status: "ready_to_call" });
  });
});

describe("a call Twilio also calls failed is left alone", () => {
  it("issues no write at all", async () => {
    const db = recordingDb({ calls: [failedCall()], leads: [readyLead()] });
    stubTwilio({ CA1111: "failed" });

    const summary = await run(db);

    expect(summary).toEqual(
      summaryOf({
        checked: 1,
        // Counted, so a dry run can report the whole 47/22/15 split — but not
        // written.
        byStatus: { failed: 1 },
        errorCodes: { none: 1 },
      }),
    );
    expect(db.writes).toEqual([]);
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

    expect(summary).toEqual(summaryOf());
    expect(twilio.requests).toEqual([]);
    expect(db.writes).toEqual([]);
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
    expect(db.writes).toEqual([]);
    expect(db.tables.calls[0].outcome).toBe("goal_met");
  });

  it("leaves a call Twilio still has in flight", async () => {
    const db = recordingDb({ calls: [failedCall()] });
    stubTwilio({ CA1111: "in-progress" });

    const summary = await run(db);

    expect(summary).toEqual(
      summaryOf({
        checked: 1,
        byStatus: { "in-progress": 1 },
        errorCodes: { none: 1 },
      }),
    );
    expect(db.writes).toEqual([]);
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

    expect(summary).toEqual(summaryOf({ checked: 1, errors: 1 }));
    expect(db.writes).toEqual([]);
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

    expect(summary).toEqual(
      summaryOf({
        checked: 2,
        updated: 1,
        byStatus: { "no-answer": 1 },
        errorCodes: { none: 1 },
        errors: 1,
      }),
    );
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
      leads: [readyLead()],
    });
    stubTwilio({ CAa: "no-answer", CAb: "busy", CAc: "failed" });

    const summary = await run(db, { dryRun: true });

    expect(summary).toEqual(
      summaryOf({
        checked: 3,
        updated: 2,
        byStatus: { "no-answer": 1, busy: 1, failed: 1 },
        errorCodes: { none: 3 },
      }),
    );
    expect(db.writes).toEqual([]);
    expect(db.tables.calls.every((r) => r.status === "failed")).toBe(true);
  });

  it("reports a would-be suppression without performing it", async () => {
    // The number that matters most in a dry-run report, and the only
    // irreversible thing this module does.
    const db = recordingDb({ calls: [failedCall()], leads: [readyLead()] });
    stubTwilio({ CA1111: { status: "failed", errorCode: 21211 } });

    const summary = await run(db, { dryRun: true });

    expect(summary).toEqual(
      summaryOf({
        checked: 1,
        updated: 1,
        suppressed: 1,
        byStatus: { failed: 1 },
        errorCodes: { "21211": 1 },
      }),
    );
    expect(db.writes).toEqual([]);
    expect(db.tables.leads[0]).toMatchObject({ status: "ready_to_call" });
    expect(db.tables.dnc_entries ?? []).toEqual([]);
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

    expect(second).toEqual(summaryOf());
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

/* ==========================================================================
 * The error code: telling a dead NUMBER from a broken US
 * ========================================================================== */

describe("a Twilio error code that names the number as dead", () => {
  it.each([
    [13224, "Twilio will not call this number, or it is invalid"],
    [21211, "invalid 'To' phone number"],
  ])("%i (%s) suppresses the lead", async (codeValue) => {
    const code = codeValue as number;
    const db = recordingDb({ calls: [failedCall()], leads: [readyLead()] });
    stubTwilio({ CA1111: { status: "failed", errorCode: code } });

    const summary = await run(db);

    expect(summary).toEqual(
      summaryOf({
        checked: 1,
        updated: 1,
        suppressed: 1,
        byStatus: { failed: 1 },
        errorCodes: { [String(code)]: 1 },
      }),
    );

    // The call. Status STAYS failed — an invalid number is a failure, and
    // Twilio's own map says failed -> failed. Only the outcome sharpens.
    expect(db.tables.calls[0]).toMatchObject({
      status: "failed",
      outcome: "invalid_number",
      outcome_source: "twilio",
      twilio_error_code: code,
    });

    // The lead is out of rotation, by BOTH of dial_queue's gates: it requires
    // status in ('ready_to_call','callback') and anti-joins the OWNER's
    // dnc_entries on (phone, owner_id). Note next_call_at going null is not
    // one of them — a null next_call_at reads as DUE in that view.
    expect(db.tables.leads[0]).toMatchObject({
      status: "dnc",
      next_call_at: null,
    });
    expect(db.tables.dnc_entries).toHaveLength(1);
    expect(db.tables.dnc_entries[0]).toMatchObject({
      phone: "+15551230000",
      owner_id: "owner-1",
      company_snapshot: "Bright Smile Dental",
      // Distinguishable forever from someone who actually asked us to stop.
      reason: "invalid_number",
      source_call_id: "call-1",
    });
  });

  it("is the ONLY path allowed to write outside calls", async () => {
    // #505 asserted this module touched no table but `calls`. That guarantee
    // is narrowed here, not dropped: it still holds everywhere above, and the
    // suppression path may reach exactly two more tables — the two the
    // post-call webhook's DNC side effects already own.
    const db = recordingDb({ calls: [failedCall()], leads: [readyLead()] });
    stubTwilio({ CA1111: { status: "failed", errorCode: 13224 } });

    await run(db);

    expect(new Set(db.tablesWritten)).toEqual(
      new Set(["calls", "leads", "dnc_entries"]),
    );
  });

  it("does not insert a second DNC row on a later pass", async () => {
    const db = recordingDb({ calls: [failedCall()], leads: [readyLead()] });
    const twilio = stubTwilio({
      CA1111: { status: "failed", errorCode: 13224 },
    });

    const first = await run(db);
    expect(first.suppressed).toBe(1);
    expect(db.tables.dnc_entries).toHaveLength(1);

    const second = await run(db);

    // Unlike a relabelled no-answer, a suppressed call KEEPS status='failed',
    // so it is still in the select's working set. What removes it is the
    // outcome guard: `invalid_number` is not overwritable, so the row is
    // skipped before Twilio is even asked.
    expect(second).toEqual(summaryOf());
    expect(twilio.requests).toHaveLength(1);
    expect(db.tables.dnc_entries).toHaveLength(1);
    expect(db.tables.leads[0]).toMatchObject({ status: "dnc" });
  });
});

describe("failures that are OURS, not the number's", () => {
  it("21215 — geolocation permissions — never suppresses a lead", async () => {
    // "Account not authorized to call this number": OUR Twilio account is not
    // permitted to dial that region. The phone may be live and somebody may be
    // sitting next to it. Suppressing on this would permanently delete real
    // leads because of a checkbox in our own console — so the code is recorded
    // as evidence and nothing else happens.
    const db = recordingDb({ calls: [failedCall()], leads: [readyLead()] });
    stubTwilio({ CA1111: { status: "failed", errorCode: 21215 } });

    const summary = await run(db);

    expect(summary).toEqual(
      summaryOf({
        checked: 1,
        // Recorded, but not a relabel and emphatically not a suppression.
        updated: 0,
        suppressed: 0,
        byStatus: { failed: 1 },
        errorCodes: { "21215": 1 },
      }),
    );
    expect(db.tablesWritten).toEqual(["calls"]);
    expect(db.tables.calls[0]).toMatchObject({
      status: "failed",
      outcome: "failed",
      // Untouched: ElevenLabs' `failed` was not wrong, only incomplete.
      outcome_source: "elevenlabs",
      twilio_error_code: 21215,
    });
    expect(db.tables.leads[0]).toMatchObject({
      status: "ready_to_call",
      next_call_at: PENDING_RETRY,
    });
    expect(db.tables.dnc_entries ?? []).toEqual([]);
  });

  it("a failure with NO error code never suppresses a lead", async () => {
    // Today's 47: price $0.00000, ElevenLabs conversation stuck at
    // `initiated`. ElevenLabs never bridged the call to Twilio, so the phone
    // was never dialed and nothing was learned about it. This is the single
    // most common failure we have; treating it as a dead number would be the
    // most expensive mistake this module could make.
    const db = recordingDb({ calls: [failedCall()], leads: [readyLead()] });
    stubTwilio({ CA1111: { status: "failed", errorCode: null } });

    const summary = await run(db);

    expect(summary).toEqual(
      summaryOf({
        checked: 1,
        byStatus: { failed: 1 },
        errorCodes: { none: 1 },
      }),
    );
    // Nothing changed and nothing new was learned, so not even a write.
    expect(db.writes).toEqual([]);
    expect(db.tables.calls[0]).toMatchObject({
      status: "failed",
      outcome: "failed",
      twilio_error_code: null,
    });
    expect(db.tables.leads[0]).toMatchObject({ status: "ready_to_call" });
    expect(db.tables.dnc_entries ?? []).toEqual([]);
  });

  it("an unrecognised code is recorded and otherwise ignored", async () => {
    // 21219 (number not verified — a trial-account limitation, ours again) is
    // the named example, but the rule is general: anything not on the list is
    // evidence, not a verdict.
    const db = recordingDb({ calls: [failedCall()], leads: [readyLead()] });
    stubTwilio({ CA1111: { status: "failed", errorCode: 21219 } });

    const summary = await run(db);

    expect(summary.suppressed).toBe(0);
    expect(summary.errorCodes).toEqual({ "21219": 1 });
    expect(db.tables.calls[0].twilio_error_code).toBe(21219);
    expect(db.tables.leads[0]).toMatchObject({ status: "ready_to_call" });
    expect(db.tables.dnc_entries ?? []).toEqual([]);
  });
});

describe("the error code is persisted as evidence", () => {
  it("is written even when nothing else about the row changes", async () => {
    // The point of the column: the suppression list grows on codes we have
    // actually seen, and a code only recorded when we already knew what to do
    // with it is not evidence of anything.
    const db = recordingDb({ calls: [failedCall()] });
    stubTwilio({ CA1111: { status: "failed", errorCode: 31005 } });

    const summary = await run(db);

    expect(db.updates).toEqual([
      { table: "calls", patch: { twilio_error_code: 31005 } },
    ]);
    expect(db.tables.calls[0].twilio_error_code).toBe(31005);
    // A code-only write is not a relabel, so it is not counted as one.
    expect(summary.updated).toBe(0);
  });

  it("rides along with a relabel", async () => {
    const db = recordingDb({ calls: [failedCall()] });
    stubTwilio({ CA1111: { status: "no-answer", errorCode: 31005 } });

    await run(db);

    expect(db.tables.calls[0]).toMatchObject({
      status: "completed",
      outcome: "no_answer",
      twilio_error_code: 31005,
    });
  });

  it("is not rewritten once it already matches", async () => {
    // The quiet-reconciler property, extended to the new column: a 15-minute
    // cron must not rewrite the same rows ninety-six times a day.
    const db = recordingDb({
      calls: [failedCall({ twilio_error_code: 21215 })],
    });
    stubTwilio({ CA1111: { status: "failed", errorCode: 21215 } });

    const summary = await run(db);

    expect(summary.checked).toBe(1);
    expect(db.writes).toEqual([]);
  });

  it("treats a non-integer code as no code at all", async () => {
    // The one thing this value must never do is coerce into a number that
    // happens to sit in DEAD_NUMBER_CODES.
    const db = recordingDb({ calls: [failedCall()], leads: [readyLead()] });
    stubTwilio({ CA1111: { status: "failed", errorCode: "not-a-code" } });

    const summary = await run(db);

    expect(summary.errorCodes).toEqual({ none: 1 });
    expect(summary.suppressed).toBe(0);
    expect(db.writes).toEqual([]);
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
    // here are the `failed` status guards and the `invalid_number` the error
    // code (not the status) implies.
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
    // module. `invalid_number` reverses this — but the fix there is the DNC
    // side effects, which the retry engine explicitly declines to own, not a
    // re-run of the engine.
    const body = code(SRC);
    expect(body).not.toContain("reapplyRetryForCall");
    expect(body).not.toContain("applyRetryForCall");
    expect(body).not.toContain("recomputeLeadCallState");
  });

  it("writes to `calls` in its own source and delegates the rest", () => {
    // #505's version of this asserted the module's `.from(...)` set was
    // exactly ["calls"]. That still holds — and now says something sharper.
    // The suppression DOES write `leads` and `dnc_entries`, but not from here:
    // it goes through applyOutcomeSideEffects, the same entry point the
    // post-call webhook, the manual override and the human-disposition path
    // use. A `.from("dnc_entries")` appearing in this file would mean someone
    // had written a SECOND implementation of "the number is bad", which is the
    // defect the whole module exists to avoid.
    const body = code(SRC);
    const tables = [...body.matchAll(/\.from\(\s*["']([a-z_]+)["']/g)].map(
      (m) => m[1],
    );
    expect([...new Set(tables)]).toEqual(["calls"]);
    expect(body).toContain("applyOutcomeSideEffects");
  });
});

describe("the dead-number list", () => {
  it("contains exactly the two verified codes", () => {
    // Pinned so adding a third is a deliberate, reviewed act rather than a
    // one-line drive-by. The asymmetry is the reason: a wrong suppression
    // permanently deletes a real lead and nothing automatic brings it back; a
    // missed one costs a few wasted dials.
    expect([...DEAD_NUMBER_CODES].sort((a, b) => a - b)).toEqual([
      13224, 21211,
    ]);
  });

  it("excludes the codes that describe US rather than the number", () => {
    // 21215 = our account may not call that region. 21219 = our account has
    // not verified the number. Neither is a statement about whether anyone
    // would pick up.
    expect(DEAD_NUMBER_CODES.has(21215)).toBe(false);
    expect(DEAD_NUMBER_CODES.has(21219)).toBe(false);
  });
});
