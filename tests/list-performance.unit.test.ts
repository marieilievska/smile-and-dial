import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import { CONNECTED_OUTCOMES } from "@/lib/calls/outcomes";
import {
  conversionRate,
  isUnattributed,
  totalsFor,
  workedShare,
  type ListPerformanceRow,
} from "@/lib/analytics/list-performance";

/**
 * Guards for "Performance by lead list" (20260906040000).
 *
 * The table exists to answer one question — which list was worth the money —
 * and every way it could lie has a test here:
 *
 *   - counting the wrong things (goal-met CALLS instead of distinct
 *     businesses, the stale stored cost total instead of the derived one),
 *   - a connected-outcome list that drifts out of step with the TypeScript
 *     one, so connect rate quietly means something different here,
 *   - date-filtering the list SIZE, which would make "worked" jump around as
 *     you move the date pills,
 *   - and the big one: SECURITY DEFINER, which would show every member every
 *     other member's lists through a report that looks correctly scoped.
 */

const MIGRATION = "supabase/migrations/20260906040000_list_performance_fn.sql";

function read(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${rel}`, import.meta.url)),
    "utf8",
  );
}

/** Drop `-- ...` comments so prose about the design never matches. */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

const sql = stripComments(read(MIGRATION));

describe("list_performance runs as the caller", () => {
  it("is SECURITY INVOKER, never DEFINER", () => {
    expect(sql).toMatch(/security invoker/);
    expect(sql).not.toMatch(/security definer/);
  });

  it("is stable, so it can be a plain read", () => {
    expect(sql).toMatch(/\bstable\b/);
  });

  it("grants execute to authenticated and to nobody else", () => {
    expect(sql).toMatch(
      /grant execute on function public\.list_performance\(date, date, uuid, uuid\) to authenticated;/,
    );
    expect(sql).not.toMatch(/grant execute[^;]*\banon\b/);
    expect(sql).not.toMatch(/grant execute[^;]*\bpublic\b\s*;/);
  });
});

describe("the connected-outcome list matches the TypeScript one", () => {
  it("is the same set, exactly", () => {
    // Both halves matter. An outcome added to CONNECTED_OUTCOMES but not here
    // would make this table's connect rate quietly lower than every other
    // page's; one added here but not there, quietly higher.
    const block = /where outcome in \(([\s\S]*?)\)/.exec(sql);
    expect(block, "connected-outcome filter not found").not.toBeNull();
    const inSql = new Set(
      [...block![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]),
    );
    expect([...inSql].sort()).toEqual([...CONNECTED_OUTCOMES].sort());
  });
});

describe("it counts what the rest of the app counts", () => {
  it("counts goals as distinct businesses, never goal-met calls", () => {
    // The app-wide rule (#279): two goal-met calls on one business is one goal.
    expect(sql).toMatch(
      /count\(distinct lead_id\) filter \(where goal_met\)::integer as goals/,
    );
  });

  it("counts decision-makers as distinct businesses too", () => {
    expect(sql).toMatch(
      /count\(distinct lead_id\) filter \(\s*where decision_maker_reached\s*\)::integer as dms/,
    );
  });

  it("derives spend with call_cost_total, never the stored total", () => {
    // cost_breakdown.total goes stale when a writer bumps a component without
    // recomputing — 1,183 of 7,888 rows were, once. call_cost_total is the SQL
    // mirror of the derivation the Costs page uses.
    expect(sql).toMatch(/public\.call_cost_total\(c\.cost_breakdown\)/);
    expect(sql).not.toMatch(/cost_breakdown\s*->>\s*'total'/);
  });

  it("buckets calls by Eastern day, like every other date filter", () => {
    const casts = sql.match(
      /\(c\.created_at at time zone 'America\/New_York'\)::date/g,
    );
    expect(casts?.length).toBe(2); // one for p_start, one for p_end
    expect(sql).not.toMatch(/c\.created_at::date/);
  });

  it("dates registrations by the dial day that paid for them", () => {
    // Same attribution as cohort_rows: money is spent on the dial day, the
    // registration lands later. created_at is only the fallback for rows
    // written before dial_day existed.
    expect(sql).toMatch(/coalesce\(\s*ce\.dial_day,/);
  });
});

describe("the list SIZE is not date-filtered", () => {
  it("counts live leads with no window and no campaign", () => {
    // A list's size is a property of the list, not of the window you are
    // looking through. If this ever took p_start/p_end, "worked" would swing
    // wildly as you moved the date pills and the column would be unreadable.
    const block = /lead_stats as \(([\s\S]*?)\n  \),/.exec(sql);
    expect(block, "lead_stats not found").not.toBeNull();
    expect(block![1]).toMatch(/where deleted_at is null/);
    expect(block![1]).not.toMatch(/p_start|p_end|p_campaign/);
  });

  it("excludes deleted leads from the size and from worked", () => {
    expect(sql).toMatch(
      /count\(distinct lead_id\) filter \(\s*where deleted_at is null\s*\)::integer as worked/,
    );
  });
});

describe("nothing is silently dropped", () => {
  it("returns registrations with no lead as their own row", () => {
    expect(sql).toMatch(/orphan_regs as \(/);
    expect(sql).toMatch(/where ce\.lead_id is null/);
  });

  it("omits that row when a campaign is selected", () => {
    // A registration with no lead has no calls, so it cannot belong to a
    // campaign; showing it under one would be an invented number.
    const block = /orphan_regs as \(([\s\S]*?)\n  \),/.exec(sql);
    expect(block![1]).toMatch(/p_campaign is null/);
  });

  it("keeps a list that has calls but no live leads", () => {
    // Its calls still cost money, so dropping the row would break the
    // reconciliation with the Costs page.
    expect(sql).toMatch(
      /where coalesce\(ls\.leads, 0\) > 0\s+or coalesce\(cs\.calls, 0\) > 0/,
    );
  });
});

const ROW: ListPerformanceRow = {
  list_id: "l1",
  list_name: "Single Location Leads",
  is_inbound: false,
  leads: 1000,
  worked: 200,
  calls: 250,
  connected: 100,
  dms: 20,
  goals: 10,
  regs: 8,
  attended: 4,
  sales: 2,
  spend: 400,
  first_call: "2026-09-02T12:00:00Z",
  last_call: "2026-09-05T12:00:00Z",
};

describe("workedShare", () => {
  it("is the share of the list dialled at least once", () => {
    expect(workedShare(ROW)).toBeCloseTo(0.2);
  });

  it("is null rather than 0 or Infinity when the list has no live leads", () => {
    expect(workedShare({ ...ROW, leads: 0 })).toBeNull();
  });
});

describe("conversionRate", () => {
  it("measures goals against businesses DIALLED, not against the whole list", () => {
    // 10 goals from 200 dialled is 5%, not 1%. Judging a part-worked list
    // against its full size is the single easiest way to misread this table.
    expect(conversionRate(ROW)).toBeCloseTo(0.05);
  });

  it("is null on a list nothing has been dialled from", () => {
    // A fresh import reads "—", not a damning 0%.
    expect(conversionRate({ ...ROW, worked: 0, goals: 0 })).toBeNull();
  });
});

describe("totalsFor", () => {
  const rows: ListPerformanceRow[] = [
    ROW,
    {
      ...ROW,
      list_id: "l2",
      list_name: "Inbound",
      leads: 42,
      worked: 42,
      calls: 46,
      connected: 44,
      dms: 2,
      goals: 0,
      regs: 0,
      attended: 0,
      sales: 0,
      spend: 2,
    },
  ];

  it("sums every count and the spend", () => {
    const t = totalsFor(rows);
    expect(t.leads).toBe(1042);
    expect(t.worked).toBe(242);
    expect(t.calls).toBe(296);
    expect(t.goals).toBe(10);
    expect(t.spend).toBe(402);
  });

  it("supports a footer rate computed from the summed parts", () => {
    // 10 goals over 242 dialled = 4.1%. Averaging the two rows' own rates
    // (5% and 0%) would give 2.5% and weight a 42-lead list like a 1,000-lead
    // one.
    const t = totalsFor(rows);
    expect(t.goals / t.worked).toBeCloseTo(0.0413, 3);
  });

  it("is all zeros for no rows", () => {
    expect(totalsFor([]).calls).toBe(0);
    expect(totalsFor([]).spend).toBe(0);
  });
});

describe("isUnattributed", () => {
  it("is true only for the synthetic no-lead row", () => {
    expect(isUnattributed(ROW)).toBe(false);
    expect(isUnattributed({ ...ROW, list_id: null, list_name: null })).toBe(
      true,
    );
  });
});

describe("only signed-in users can run the report", () => {
  const grants = stripComments(
    read(
      "supabase/migrations/20260906041000_grant_cost_helpers_to_authenticated.sql",
    ),
  );
  const revokes = stripComments(
    read("supabase/migrations/20260906042000_list_performance_not_public.sql"),
  );

  it("grants the cost helpers the report reaches through", () => {
    // call_cost_total is a plain SQL function, so its internals run with the
    // CALLER's privileges. j_num was created after the function lock-down and
    // carried no grant, so as a signed-in user the whole page failed with
    // "permission denied for function j_num". Caught by simulating the roles,
    // not by tsc or the build -- neither can see a database grant.
    for (const fn of [
      "j_num(jsonb, text)",
      "call_cost_components(jsonb)",
      "call_cost_total(jsonb)",
    ]) {
      expect(grants).toContain(
        `grant execute on function public.${fn} to authenticated;`,
      );
    }
  });

  it("closes the report to anon", () => {
    // Harmless either way -- SECURITY INVOKER means an anonymous caller sees
    // nothing -- but a report is not something the anon key should be able to
    // run, and cohort_rows next door carries exactly three grants.
    // Two plain-substring checks rather than one wrapped statement, so the
    // assertion does not depend on where prettier breaks the line.
    expect(revokes).toContain(
      "revoke execute on function public.list_performance(date, date, uuid, uuid)",
    );
    expect(revokes).toContain("from public, anon;");
  });
});
