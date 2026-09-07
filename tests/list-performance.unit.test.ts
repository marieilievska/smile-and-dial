import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import { CONNECTED_OUTCOMES } from "@/lib/calls/outcomes";
import { COST_COMPONENT_KEYS } from "@/lib/costs/breakdown";
import {
  conversionRate,
  isUnattributed,
  mobileShare,
  reachedShare,
  totalsFor,
  voicemailShare,
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

const MIGRATIONS = "supabase/migrations";
const COST_FN =
  "supabase/migrations/20260906055000_call_cost_total_inlinable.sql";

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

/** Newest migration that (re)defines `needle`, comments stripped. */
function latestDefining(needle: string): string {
  const dir = fileURLToPath(new URL(`../${MIGRATIONS}`, import.meta.url));
  const hit = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .reverse()
    .map((f) => read(`${MIGRATIONS}/${f}`))
    .find((s) => s.includes(needle));
  if (!hit) throw new Error(`no migration defines ${needle}`);
  return stripComments(hit);
}

// The LATEST definition, RESOLVED rather than pinned by hand. This function
// gets dropped and recreated whole every time a column is added, so a
// hand-written filename goes stale the moment the next phase lands and these
// guards would then be pinning a definition that is no longer live.
//
// The needle ends at the open paren and a newline because the signature is
// multi-line: it matches `create function` and `create or replace function`
// alike, and matches none of the grant / revoke / comment statements, which
// all put `(date, date, uuid, uuid)` on the same line.
const sql = latestDefining("function public.list_performance(\n");

/**
 * One named CTE's body: from `<name> as (` to its OWN closing `\n  ),`.
 *
 * Slicing from one CTE name to the next silently widens when something is
 * inserted in the gap — `worked_recent` landing between `bad_leads` and
 * `reg_stats` quietly pulled pace inside the bad-number guard. Bounding each
 * slice by the CTE's own closing paren means an inserted CTE cannot creep into
 * a test that never meant to cover it.
 */
function cte(name: string): string {
  const body = new RegExp(`${name} as \\(([\\s\\S]*?)\\n  \\),`).exec(sql);
  if (!body) throw new Error(`CTE ${name} not found`);
  return body[1];
}

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
    const block = cte("lead_stats");
    expect(block).toContain("deleted_at is null");
    expect(block).not.toMatch(/p_start|p_end|p_campaign/);
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
    expect(cte("orphan_regs")).toMatch(/p_campaign is null/);
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
  reached: 80,
  voicemail: 125,
  line_typed: 0,
  mobiles: 0,
  bad_number: 3,
  suppressed: 5,
  resting: 40,
  remaining: 700,
  no_show: 4,
  pending: 12,
  worked_7d: 7476,
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

  it("sums the economics columns too", () => {
    const t = totalsFor([
      { ...ROW, no_show: 3, pending: 5, worked_7d: 100 },
      { ...ROW, no_show: 1, pending: 7, worked_7d: 40 },
    ]);
    expect(t.no_show).toBe(4);
    expect(t.pending).toBe(12);
    expect(t.worked_7d).toBe(140);
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

describe("remaining is inventory, not the dial queue", () => {
  // The trap this test exists for: dial_queue looks like the obvious source
  // for "how many are left", and it is not. It is gated on calling hours and
  // on per-hour / per-day caps, so counting it returns ZERO every night --
  // which as a report column reads as "this list is finished".
  const filter = sql.slice(
    sql.indexOf("as suppressed"),
    sql.indexOf("::integer as remaining"),
  );

  it("mirrors dial_queue's lead-level predicates", () => {
    expect(filter).toContain("l.business_phone is not null");
    expect(filter).toContain("l.status in ('ready_to_call', 'callback')");
    expect(filter).toContain("l.line_type is distinct from 'mobile'");
    expect(filter).toContain("from dnc_entries d");
    expect(filter).toContain("d.owner_id = l.owner_id");
  });

  it("borrows none of dial_queue's clock or capacity gates", () => {
    expect(sql).not.toContain("is_within_calling_hours");
    expect(sql).not.toContain("next_call_at");
    expect(sql).not.toContain("calls_per_hour_cap");
    expect(sql).not.toContain("autopilot_enabled");
  });

  it("keeps the do-not-call check per owner, matching enforcement", () => {
    // Suppression is per person since 20260906020000. A teammate's list must
    // not make your leads look unworkable.
    expect(filter).toContain("d.owner_id = l.owner_id");
  });
});

describe("the inventory columns ignore the campaign filter too", () => {
  it("counts bad numbers per list, not per campaign", () => {
    // A dead number is a property of the lead. Scoping it to the selected
    // campaign would make the same list look cleaner under one campaign than
    // another.
    const bad = cte("bad_leads");
    expect(bad).toContain("c.outcome = 'invalid_number'");
    expect(bad).not.toContain("p_campaign");
    expect(bad).not.toContain("p_start");
  });
});

describe("reached uses the same connected-outcome list as connected", () => {
  it("does not define a second, divergent list", () => {
    const lists = [...sql.matchAll(/outcome in \(([\s\S]*?)\)/g)].map((m) =>
      [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).join(","),
    );
    expect(lists.length).toBe(2);
    expect(lists[0]).toBe(lists[1]);
    expect(lists[0].split(",").sort()).toEqual([...CONNECTED_OUTCOMES].sort());
  });
});

describe("call_cost_total was made inlinable (20260906055000)", () => {
  const cost = stripComments(read(COST_FN));

  it("reads the component keys directly, and only those", () => {
    for (const key of COST_COMPONENT_KEYS) {
      expect(cost, key).toContain(`j -> '${key}'`);
    }
    // Five components plus the stored-total fallback, and nothing else.
    expect(cost.match(/pg_catalog\.jsonb_typeof/g)).toHaveLength(
      COST_COMPONENT_KEYS.length + 1,
    );
  });

  it("carries no SET clause and calls no helper", () => {
    // A SQL function with a SET clause cannot be inlined -- that single rule
    // is what made this 91% of the query. Schema-qualifying jsonb_typeof
    // keeps the hardening without paying for it.
    expect(cost).not.toContain("set search_path");
    expect(cost).not.toContain("call_cost_components(");
    expect(cost).not.toContain("j_num(");
  });

  it("keeps the old semantics exactly, writing the sum once", () => {
    // coalesce(nullif(greatest(sum, 0), 0), total) reproduces
    // "components > 0 ? components : total", negative branch included.
    expect(cost).toContain("coalesce(");
    expect(cost).toContain("nullif(");
    expect(cost).toContain("greatest(");
    expect(cost).toContain("immutable");
  });
});

describe("reachedShare", () => {
  it("measures who answered against who we dialled", () => {
    expect(reachedShare(ROW)).toBeCloseTo(0.4);
  });

  it("is null before anything has been dialled", () => {
    expect(reachedShare({ ...ROW, worked: 0, reached: 0 })).toBeNull();
  });
});

describe("voicemailShare", () => {
  it("is a share of CALLS, not of leads", () => {
    // 125 of 250 calls. Against leads it would read 12.5% and mean nothing.
    expect(voicemailShare(ROW)).toBeCloseTo(0.5);
  });

  it("is null on a list with no calls", () => {
    expect(voicemailShare({ ...ROW, calls: 0, voicemail: 0 })).toBeNull();
  });
});

describe("mobileShare", () => {
  it("is null when no line type has ever been looked up", () => {
    // The whole point: "we checked and found none" and "we never checked"
    // must not both render as 0.0%. Today every list is the second one.
    expect(mobileShare(ROW)).toBeNull();
  });

  it("is a real share once lookups have run", () => {
    expect(mobileShare({ ...ROW, line_typed: 1000, mobiles: 250 })).toBeCloseTo(
      0.25,
    );
  });

  it("stays null for a list with no leads", () => {
    expect(mobileShare({ ...ROW, leads: 0, line_typed: 5 })).toBeNull();
  });
});

describe("the economics columns", () => {
  it("uses cohort_rows' no-show rule, 24h grace and all", () => {
    // If these two functions disagree about a show rate, nobody can tell
    // which page is lying. So the predicate is compared, not paraphrased —
    // all THREE conjuncts, including the cancellation guard, which is the one
    // most likely to drift because dropping it still returns a plausible
    // number.
    const cohort = stripComments(
      read("supabase/migrations/20260905130000_cohort_rows_fn.sql"),
    );
    const rule =
      /ce\.status <> 'canceled'\s+and ce\.attended_at is null\s+and ce\.scheduled_at < now\(\) - interval '24 hours'/;
    expect(cohort).toMatch(rule);
    // Both copies. Matching the whole file would pass while one of the two
    // drifted, because the other still carries the full predicate.
    expect(cte("reg_stats")).toMatch(rule);
    expect(cte("orphan_regs")).toMatch(rule);
  });

  it("uses cohort_rows' pending rule too", () => {
    const cohort = stripComments(
      read("supabase/migrations/20260905130000_cohort_rows_fn.sql"),
    );
    const rule =
      /ce\.status <> 'canceled'\s+and ce\.attended_at is null\s+and ce\.scheduled_at >= now\(\) - interval '24 hours'/;
    expect(cohort).toMatch(rule);
    expect(cte("reg_stats")).toMatch(rule);
    expect(cte("orphan_regs")).toMatch(rule);
  });

  it("gives the unattributed row its own no_show and pending", () => {
    // Otherwise settled + pending = regs breaks on that row.
    expect(sql).toMatch(/o\.no_show, o\.pending, 0/);
  });

  it("measures pace over 7 days, ignoring the date and campaign filters", () => {
    // Pace is a property of NOW. A Days-left that moved with the date pills
    // would be worse than no Days-left at all.
    const pace = cte("worked_recent");
    expect(pace).toMatch(/created_at >= now\(\) - interval '7 days'/);
    expect(pace).not.toMatch(/p_start|p_end|p_campaign/);
  });

  it("counts pace on OUTBOUND calls only, because only dialling burns a list", () => {
    // calls.direction is not null and is either 'inbound' or 'outbound'. An
    // inbound call is somebody returning a missed call: it consumes no
    // inventory, so a Days-left that counted it would claim the Inbound list
    // was being burned through by calls we never made.
    //
    // `worked` in call_stats deliberately does NOT filter direction — it
    // answers "how many businesses did we interact with", not "how fast are we
    // consuming the list" — so the asymmetry is intended, not a bug.
    expect(cte("worked_recent")).toContain("c.direction = 'outbound'");
    expect(cte("call_stats")).not.toContain("direction");
  });

  it("re-grants execute AFTER the drop, so the new function is reachable", () => {
    // A dropped function is a NEW function and takes none of the old one's
    // privileges with it. A GRANT written above the DROP would land on the
    // function about to be destroyed, and every signed-in user would get
    // "permission denied for function list_performance" instead of a page.
    const dropped = sql.indexOf(
      "drop function if exists public.list_performance",
    );
    const granted = sql.indexOf(
      "grant execute on function public.list_performance",
    );
    expect(dropped, "no drop found").toBeGreaterThanOrEqual(0);
    expect(granted).toBeGreaterThan(dropped);
  });
});
