import { describe, expect, test } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import { runRetentionSweep } from "@/lib/maintenance/retention";
import {
  RETENTION_DAYS,
  isPastRetention,
  isStorageObjectPath,
  partitionRecordingRows,
  retentionCutoff,
} from "@/lib/maintenance/retention-window";
import type { Database } from "@/lib/supabase/database.types";

const NOW = new Date("2026-09-05T12:00:00.000Z");
// 90 days before NOW. Sept 5 → Aug 31 is 5 days, +31 (Aug) = 36, +31 (Jul)
// = 67, and the remaining 23 land on June 7.
const CUTOFF_ISO = "2026-06-07T12:00:00.000Z";

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString();

describe("retention window", () => {
  test("the default window is 90 days", () => {
    expect(RETENTION_DAYS).toBe(90);
    expect(retentionCutoff(undefined, NOW).toISOString()).toBe(CUTOFF_ISO);
  });

  test("isPastRetention: strictly older than 90 days", () => {
    expect(isPastRetention(daysAgo(91), { now: NOW })).toBe(true);
    expect(isPastRetention(daysAgo(89), { now: NOW })).toBe(false);
    // Exactly on the cutoff is NOT past — the sweep uses `created_at <
    // cutoff`, so the UI must match and not claim a still-present file is gone.
    expect(isPastRetention(CUTOFF_ISO, { now: NOW })).toBe(false);
    expect(isPastRetention(daysAgo(0), { now: NOW })).toBe(false);
  });

  test("isPastRetention: honours a custom window", () => {
    expect(isPastRetention(daysAgo(31), { days: 30, now: NOW })).toBe(true);
    expect(isPastRetention(daysAgo(91), { days: 365, now: NOW })).toBe(false);
  });

  test("isPastRetention: unknown timestamps are never 'past'", () => {
    expect(isPastRetention(null, { now: NOW })).toBe(false);
    expect(isPastRetention(undefined, { now: NOW })).toBe(false);
    expect(isPastRetention("", { now: NOW })).toBe(false);
    expect(isPastRetention("not a date", { now: NOW })).toBe(false);
  });

  test("isStorageObjectPath: object keys yes, http(s) URLs and blanks no", () => {
    expect(isStorageObjectPath("abc.mp3")).toBe(true);
    expect(isStorageObjectPath("2026/06/abc.mp3")).toBe(true);
    expect(isStorageObjectPath("https://api.twilio.com/Recordings/RE1")).toBe(
      false,
    );
    expect(isStorageObjectPath("HTTP://example.com/x.mp3")).toBe(false);
    expect(isStorageObjectPath("")).toBe(false);
  });

  test("partitionRecordingRows: URLs are nulled but never sent to the bucket", () => {
    const out = partitionRecordingRows([
      { id: "c1", recording_path: "c1.mp3" },
      { id: "c2", recording_path: "https://api.twilio.com/Recordings/RE2" },
      { id: "c3", recording_path: "c3.mp3" },
      { id: "c4", recording_path: null },
      { id: "c5", recording_path: "" },
      { id: "c6", recording_path: "c1.mp3" },
    ]);
    expect(out.storagePaths).toEqual(["c1.mp3", "c3.mp3"]);
    expect(out.callIds).toEqual(["c1", "c2", "c3", "c5", "c6"]);
  });
});

// ---------------------------------------------------------------------------
// runRetentionSweep against a fake Supabase client
// ---------------------------------------------------------------------------

type Filter = { fn: string; args: unknown[] };
type Op = {
  table: string;
  kind: "select" | "update" | "delete" | "insert";
  payload?: unknown;
  options?: Record<string, unknown>;
  filters: Filter[];
  limit?: number;
};
type Reply = {
  data?: unknown;
  count?: number | null;
  error?: { message: string } | null;
};
type Responder = (op: Op) => Reply;

/** Which filter column was used first — tells the recording select from the
 *  transcript select on the same `calls` table. */
function firstFilterColumn(op: Op): string | undefined {
  return op.filters[0]?.args[0] as string | undefined;
}
function inFilter(op: Op): unknown[] | undefined {
  return op.filters.find((f) => f.fn === "in")?.args[1] as
    | unknown[]
    | undefined;
}
function isHeadCount(op: Op): boolean {
  return op.kind === "select" && op.options?.head === true;
}

/** A minimal thenable query-builder fake. Every chained call is recorded on
 *  one `Op`; awaiting the builder hands the Op to `respond` and resolves with
 *  its reply in supabase-js shape ({ data, count, error }). */
function makeFakeAdmin(
  respond: Responder,
  storageRemove?: (
    paths: string[],
  ) => Promise<{ data: unknown; error: { message: string } | null }>,
) {
  const ops: Op[] = [];
  const removed: string[][] = [];

  function from(table: string) {
    const op: Op = { table, kind: "select", filters: [] };
    const builder = {
      select(cols: string, options?: Record<string, unknown>) {
        if (op.kind === "select") {
          op.payload = cols;
          op.options = options;
        }
        return builder;
      },
      update(patch: unknown, options?: Record<string, unknown>) {
        op.kind = "update";
        op.payload = patch;
        op.options = options;
        return builder;
      },
      delete(options?: Record<string, unknown>) {
        op.kind = "delete";
        op.options = options;
        return builder;
      },
      insert(row: unknown) {
        op.kind = "insert";
        op.payload = row;
        return builder;
      },
      not(...args: unknown[]) {
        op.filters.push({ fn: "not", args });
        return builder;
      },
      lt(...args: unknown[]) {
        op.filters.push({ fn: "lt", args });
        return builder;
      },
      in(...args: unknown[]) {
        op.filters.push({ fn: "in", args });
        return builder;
      },
      order() {
        return builder;
      },
      limit(n: number) {
        op.limit = n;
        return builder;
      },
      then(
        resolve: (value: {
          data: unknown;
          count: number | null;
          error: { message: string } | null;
        }) => void,
        reject?: (reason: unknown) => void,
      ) {
        ops.push(op);
        try {
          const r = respond(op);
          resolve({
            data: r.data ?? null,
            count: r.count ?? null,
            error: r.error ?? null,
          });
        } catch (error) {
          if (reject) reject(error);
          else throw error;
        }
      },
    };
    return builder;
  }

  const admin = {
    from,
    storage: {
      from: (_bucket: string) => ({
        remove: async (paths: string[]) => {
          removed.push(paths);
          return storageRemove
            ? storageRemove(paths)
            : { data: [], error: null };
        },
      }),
    },
  };
  return {
    admin: admin as unknown as SupabaseClient<Database>,
    ops,
    removed,
  };
}

/** The canonical "one of everything" night: 3 old recordings (one a legacy
 *  Twilio URL), 2 old transcripts, 3 old webhook rows across 2 conversations,
 *  nothing left afterwards. */
function happyPathResponder(): Responder {
  return (op) => {
    if (isHeadCount(op)) return { count: 0 };
    if (op.table === "calls" && op.kind === "select") {
      if (firstFilterColumn(op) === "recording_path") {
        return {
          data: [
            { id: "c1", recording_path: "c1.mp3" },
            { id: "c2", recording_path: "https://api.twilio.com/Rec/RE2" },
            { id: "c3", recording_path: "c3.mp3" },
          ],
        };
      }
      if (firstFilterColumn(op) === "transcript_json") {
        return { data: [{ id: "c1" }, { id: "c4" }] };
      }
    }
    if (op.table === "calls" && op.kind === "update") {
      return { count: inFilter(op)?.length ?? 0 };
    }
    if (op.table === "elevenlabs_webhook_events" && op.kind === "select") {
      return {
        data: [
          { conversation_id: "conv1" },
          { conversation_id: "conv1" },
          { conversation_id: "conv2" },
        ],
      };
    }
    if (op.table === "elevenlabs_webhook_events" && op.kind === "delete") {
      return { count: 3 };
    }
    if (op.table === "system_events" && op.kind === "insert") return {};
    throw new Error(`unexpected op ${op.table}.${op.kind}`);
  };
}

describe("runRetentionSweep", () => {
  test("removes old audio objects, nulls the columns, prunes the webhook log, logs one system event", async () => {
    const { admin, ops, removed } = makeFakeAdmin(happyPathResponder());
    const summary = await runRetentionSweep(admin, { now: NOW, limit: 200 });

    expect(summary.days).toBe(90);
    expect(summary.cutoff).toBe(CUTOFF_ISO);
    expect(summary.recordingsRemoved).toBe(3);
    expect(summary.transcriptsCleared).toBe(2);
    expect(summary.webhookRowsDeleted).toBe(3);
    expect(summary.remaining).toEqual({
      recordings: 0,
      transcripts: 0,
      webhookRows: 0,
    });
    expect(summary.errors).toEqual([]);

    // Only real object keys went to the bucket — the Twilio URL did not.
    expect(removed).toEqual([["c1.mp3", "c3.mp3"]]);

    // Every selected row (URL row included) had recording_path nulled.
    const recUpdate = ops.find(
      (o) =>
        o.table === "calls" &&
        o.kind === "update" &&
        "recording_path" in (o.payload as object),
    );
    expect(recUpdate?.payload).toEqual({ recording_path: null });
    expect(inFilter(recUpdate!)).toEqual(["c1", "c2", "c3"]);

    // Transcripts: ONLY transcript_json is touched.
    const trUpdate = ops.find(
      (o) =>
        o.table === "calls" &&
        o.kind === "update" &&
        "transcript_json" in (o.payload as object),
    );
    expect(trUpdate?.payload).toEqual({ transcript_json: null });
    expect(inFilter(trUpdate!)).toEqual(["c1", "c4"]);

    // Every select / update / delete is bounded by the cutoff — the writes
    // too, even though their ids already came from a bounded select.
    for (const o of ops) {
      if (o.table === "system_events") continue;
      const lt = o.filters.find((f) => f.fn === "lt");
      expect(lt?.args[1]).toBe(CUTOFF_ISO);
    }

    // Webhook delete: de-duplicated conversation ids + the cutoff guard.
    const whDelete = ops.find(
      (o) => o.table === "elevenlabs_webhook_events" && o.kind === "delete",
    );
    expect(inFilter(whDelete!)).toEqual(["conv1", "conv2"]);
    expect(whDelete?.options).toEqual({ count: "exact" });

    // One audit row, carrying the summary.
    const events = ops.filter((o) => o.table === "system_events");
    expect(events).toHaveLength(1);
    const row = events[0].payload as Record<string, unknown>;
    expect(row.kind).toBe("retention_sweep");
    expect(row.actor_user_id).toBeNull();
    expect((row.payload as Record<string, unknown>).recordingsRemoved).toBe(3);
  });

  test("a quiet night (nothing past the window) removes nothing and logs nothing", async () => {
    const { admin, ops, removed } = makeFakeAdmin((op) => {
      if (isHeadCount(op)) return { count: 0 };
      if (op.kind === "select") return { data: [] };
      throw new Error(`unexpected op ${op.table}.${op.kind}`);
    });
    const summary = await runRetentionSweep(admin, { now: NOW });

    expect(summary.recordingsRemoved).toBe(0);
    expect(summary.transcriptsCleared).toBe(0);
    expect(summary.webhookRowsDeleted).toBe(0);
    expect(summary.errors).toEqual([]);
    expect(removed).toEqual([]);
    expect(ops.filter((o) => o.kind !== "select")).toEqual([]);
  });

  test("a storage failure leaves recording_path alone (retry tomorrow) and does not stop the other stages", async () => {
    const base = happyPathResponder();
    const { admin, ops } = makeFakeAdmin(base, async () => ({
      data: null,
      error: { message: "bucket unreachable" },
    }));
    const summary = await runRetentionSweep(admin, { now: NOW });

    expect(summary.recordingsRemoved).toBe(0);
    expect(
      ops.some(
        (o) =>
          o.table === "calls" &&
          o.kind === "update" &&
          "recording_path" in (o.payload as object),
      ),
    ).toBe(false);
    // The other two stages still ran to completion.
    expect(summary.transcriptsCleared).toBe(2);
    expect(summary.webhookRowsDeleted).toBe(3);
    expect(summary.errors).toEqual([
      "recordings: storage remove failed: bucket unreachable",
    ]);
    // Something was removed, so the audit row is still written.
    expect(ops.filter((o) => o.table === "system_events")).toHaveLength(1);
  });

  test("keeps batching until a batch comes back short", async () => {
    let recordingSelects = 0;
    const { admin, removed } = makeFakeAdmin((op) => {
      if (isHeadCount(op)) return { count: 0 };
      if (op.table === "calls" && op.kind === "select") {
        if (firstFilterColumn(op) === "recording_path") {
          recordingSelects += 1;
          if (recordingSelects === 1) {
            return {
              data: [
                { id: "a", recording_path: "a.mp3" },
                { id: "b", recording_path: "b.mp3" },
              ],
            };
          }
          if (recordingSelects === 2) {
            return { data: [{ id: "c", recording_path: "c.mp3" }] };
          }
          throw new Error("should have stopped after the short batch");
        }
        return { data: [] };
      }
      if (op.table === "calls" && op.kind === "update") {
        return { count: inFilter(op)?.length ?? 0 };
      }
      if (op.kind === "select") return { data: [] };
      if (op.table === "system_events") return {};
      throw new Error(`unexpected op ${op.table}.${op.kind}`);
    });
    const summary = await runRetentionSweep(admin, { now: NOW, limit: 2 });

    expect(recordingSelects).toBe(2);
    expect(removed).toEqual([["a.mp3", "b.mp3"], ["c.mp3"]]);
    expect(summary.recordingsRemoved).toBe(3);
    expect(summary.errors).toEqual([]);
  });

  test("stops when the time budget is spent and reports what is left", async () => {
    const { admin, ops } = makeFakeAdmin((op) => {
      if (isHeadCount(op)) {
        return { count: firstFilterColumn(op) === "recording_path" ? 7 : 0 };
      }
      throw new Error(`budget was zero; no batch should run (${op.kind})`);
    });
    const summary = await runRetentionSweep(admin, { now: NOW, budgetMs: 0 });

    expect(summary.recordingsRemoved).toBe(0);
    expect(summary.remaining.recordings).toBe(7);
    expect(summary.errors).toEqual([]);
    expect(ops.every((o) => isHeadCount(o))).toBe(true);
  });

  test("never throws: a failing select is recorded as an error, the rest still runs", async () => {
    const { admin } = makeFakeAdmin((op) => {
      if (isHeadCount(op)) return { count: null };
      if (op.table === "calls" && op.kind === "select") {
        if (firstFilterColumn(op) === "recording_path") {
          return { error: { message: "timeout" } };
        }
        throw new Error("connection reset");
      }
      if (op.table === "elevenlabs_webhook_events" && op.kind === "select") {
        return { data: [{ conversation_id: "x" }] };
      }
      if (op.table === "elevenlabs_webhook_events" && op.kind === "delete") {
        return { count: 1 };
      }
      if (op.table === "system_events") return {};
      throw new Error(`unexpected op ${op.table}.${op.kind}`);
    });
    const summary = await runRetentionSweep(admin, { now: NOW });

    expect(summary.recordingsRemoved).toBe(0);
    expect(summary.transcriptsCleared).toBe(0);
    expect(summary.webhookRowsDeleted).toBe(1);
    expect(summary.errors).toEqual([
      "recordings: select failed: timeout",
      "transcripts: connection reset",
    ]);
    // A count that returned null (not an error) is reported as 0.
    expect(summary.remaining).toEqual({
      recordings: 0,
      transcripts: 0,
      webhookRows: 0,
    });
  });
});
