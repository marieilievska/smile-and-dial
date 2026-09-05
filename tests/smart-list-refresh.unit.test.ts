import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import {
  REFRESH_FAILURE_EVENT_THROTTLE_MS,
  SMART_LIST_REFRESH_FAILED_KIND,
  refreshSmartListMembers,
} from "../src/lib/smart-lists/cache";
import type { Database } from "../src/lib/supabase/database.types";

/**
 * The smart-list refresh cron used to throw on the first list that failed
 * and skip every list after it, with nothing recorded anywhere. These tests
 * drive refreshSmartListMembers() against a small fake of the service-role
 * client and pin the new contract:
 *   - one failure never stops the others;
 *   - the tally reports refreshed / failed honestly;
 *   - a failed list is marked stale (last_refresh_error) every time;
 *   - the system_events row is throttled to one per list per hour.
 */

type Write = { table: string; op: "update" | "insert"; payload: unknown };
type Filter = [column: string, op: string, value: unknown];

function fakeAdmin(opts: {
  attached: string[];
  names?: Record<string, string>;
  rpc: (id: string) => {
    data: number | null;
    error: { message: string } | null;
  };
  /** Ids that already have a recent failure event (inside the throttle). */
  recentlyLogged?: string[];
}) {
  const writes: Write[] = [];
  const rpcCalls: string[] = [];

  function execute(state: {
    table: string;
    op: string;
    payload: unknown;
    filters: Filter[];
  }) {
    if (state.op === "update" || state.op === "insert") {
      writes.push({
        table: state.table,
        op: state.op,
        payload:
          state.op === "update"
            ? { ...(state.payload as object), _where: state.filters }
            : state.payload,
      });
      return { data: null, error: null };
    }
    switch (state.table) {
      case "campaigns":
        return {
          data: opts.attached.map((smart_list_id) => ({ smart_list_id })),
          error: null,
        };
      case "smart_lists": {
        const ids = (state.filters.find((f) => f[1] === "in")?.[2] ??
          []) as string[];
        return {
          data: ids.map((id) => ({
            id,
            name: opts.names?.[id] ?? `List ${id}`,
          })),
          error: null,
        };
      }
      case "system_events": {
        const id = state.filters.find((f) => f[0] === "ref_id")?.[2] as string;
        const since = state.filters.find((f) => f[0] === "created_at")?.[2];
        // The throttle window must be asked for explicitly.
        expect(typeof since).toBe("string");
        return {
          data: opts.recentlyLogged?.includes(id) ? [{ id: "evt" }] : [],
          error: null,
        };
      }
      default:
        throw new Error(`unexpected table ${state.table}`);
    }
  }

  function from(table: string) {
    const state = {
      table,
      op: "select",
      payload: undefined as unknown,
      filters: [] as Filter[],
    };
    const b = {
      select: () => b,
      not: (c: string, o: string, v: unknown) => {
        state.filters.push([c, `not.${o}`, v]);
        return b;
      },
      eq: (c: string, v: unknown) => {
        state.filters.push([c, "eq", v]);
        return b;
      },
      in: (c: string, v: unknown) => {
        state.filters.push([c, "in", v]);
        return b;
      },
      gte: (c: string, v: unknown) => {
        state.filters.push([c, "gte", v]);
        return b;
      },
      limit: () => b,
      update: (p: unknown) => {
        state.op = "update";
        state.payload = p;
        return b;
      },
      insert: (p: unknown) => {
        state.op = "insert";
        state.payload = p;
        return b;
      },
      then: (
        resolve: (v: unknown) => unknown,
        reject?: (e: unknown) => unknown,
      ) =>
        Promise.resolve()
          .then(() => execute(state))
          .then(resolve, reject),
    };
    return b;
  }

  const client = {
    from,
    rpc: async (_fn: string, args: { in_id: string }) => {
      rpcCalls.push(args.in_id);
      return opts.rpc(args.in_id);
    },
  };
  return {
    client: client as unknown as SupabaseClient<Database>,
    writes,
    rpcCalls,
  };
}

const ok = (n: number) => ({ data: n, error: null });
const fail = (message: string) => ({ data: null, error: { message } });

describe("refreshSmartListMembers", () => {
  it("refreshes every attached list once, deduplicating campaigns that share one", async () => {
    const fake = fakeAdmin({
      attached: ["a", "b", "a"],
      rpc: (id) => ok(id === "a" ? 10 : 5),
    });
    const summary = await refreshSmartListMembers(fake.client);
    expect(fake.rpcCalls).toEqual(["a", "b"]);
    expect(summary).toMatchObject({
      ok: true,
      refreshed: 2,
      failed: 0,
      totalMembers: 15,
      failures: [],
    });
    expect(fake.writes).toEqual([]);
  });

  it("continues past a failing list and tallies it instead of throwing", async () => {
    const fake = fakeAdmin({
      attached: ["a", "b", "c"],
      names: { b: "Warm — never called" },
      rpc: (id) =>
        id === "b" ? fail("operator does not exist: text = uuid") : ok(3),
    });
    const summary = await refreshSmartListMembers(fake.client);
    expect(fake.rpcCalls).toEqual(["a", "b", "c"]);
    expect(summary.ok).toBe(false);
    expect(summary.refreshed).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.totalMembers).toBe(6);
    expect(summary.failures).toEqual([
      {
        id: "b",
        name: "Warm — never called",
        error: "operator does not exist: text = uuid",
      },
    ]);
  });

  it("marks the failed list stale and writes one audit row", async () => {
    const fake = fakeAdmin({
      attached: ["b"],
      names: { b: "Warm" },
      rpc: () => fail("boom"),
    });
    await refreshSmartListMembers(fake.client);
    expect(fake.writes).toEqual([
      {
        table: "smart_lists",
        op: "update",
        payload: { last_refresh_error: "boom", _where: [["id", "eq", "b"]] },
      },
      {
        table: "system_events",
        op: "insert",
        payload: {
          kind: SMART_LIST_REFRESH_FAILED_KIND,
          actor_user_id: null,
          ref_table: "smart_lists",
          ref_id: "b",
          payload: { name: "Warm", error: "boom" },
        },
      },
    ]);
  });

  it("throttles the audit row to one per list per hour but always refreshes the stale marker", async () => {
    const fake = fakeAdmin({
      attached: ["b"],
      rpc: () => fail("boom again"),
      recentlyLogged: ["b"],
    });
    await refreshSmartListMembers(fake.client);
    expect(fake.writes.map((w) => `${w.table}:${w.op}`)).toEqual([
      "smart_lists:update",
    ]);
    expect(REFRESH_FAILURE_EVENT_THROTTLE_MS).toBe(60 * 60 * 1000);
  });

  it("treats a thrown rpc (network) the same as an error result", async () => {
    const fake = fakeAdmin({
      attached: ["a", "b"],
      rpc: (id) => {
        if (id === "a") throw new Error("fetch failed");
        return ok(1);
      },
    });
    const summary = await refreshSmartListMembers(fake.client);
    expect(summary.failed).toBe(1);
    expect(summary.refreshed).toBe(1);
    expect(summary.failures[0]).toMatchObject({
      id: "a",
      error: "fetch failed",
    });
  });

  it("does nothing when no campaign has a smart list attached", async () => {
    const fake = fakeAdmin({ attached: [], rpc: () => ok(0) });
    const summary = await refreshSmartListMembers(fake.client);
    expect(summary).toMatchObject({ ok: true, refreshed: 0, failed: 0 });
    expect(fake.rpcCalls).toEqual([]);
  });
});
