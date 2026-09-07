// tests/reporting-daily-kpis.unit.test.ts
//
// reporting_daily_kpis re-implements, in SQL, counting rules that also exist in
// TypeScript (src/lib/agent-analytics/stats.ts). These read the migration text
// and pin the parts that would go wrong silently.
//
// Behavioural parity is checked against production by
// `npm run verify:reporting`, which runs both paths over seven windows and
// diffs every counter on every day.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { CONNECTED_OUTCOMES } from "@/lib/calls/outcomes";
import { OUTCOME_EXCLUDES_DM } from "@/lib/calls/decision-maker";
import { computeDailyKpis, warmPctOf } from "@/lib/agent-analytics/stats";

const sql = readFileSync(
  "supabase/migrations/20260907090000_reporting_daily_kpis.sql",
  "utf8",
);

/** Just the function BODY, with `--` comments stripped — for assertions about
 *  what the SQL DOES. The header and the `comment on function` string both
 *  legitimately discuss the implementation in prose, and an assertion that
 *  prose can satisfy (or break) is not testing anything. */
const code = (() => {
  const open = sql.indexOf("as $$");
  const close = sql.indexOf("$$;", open);
  expect(open, "function body not found").toBeGreaterThan(-1);
  return sql
    .slice(open, close)
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
})();

/** Quoted values inside the parenthesised list that follows `marker`. */
function listAfter(marker: string, opener: string): Set<string> {
  const start = sql.indexOf(marker);
  expect(start, `marker not found: ${marker}`).toBeGreaterThan(-1);
  const open = sql.indexOf(opener, start - 400 > 0 ? start - 400 : 0);
  const close = sql.indexOf(")", open + opener.length);
  return new Set(
    [...sql.slice(open, close).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]),
  );
}

describe("reporting_daily_kpis runs as the caller", () => {
  it("is SECURITY INVOKER, never DEFINER", () => {
    // Reporting is open to members, scoped by RLS to leads they own. The public
    // share surface reaches it through a service-role client, which bypasses
    // RLS by design. DEFINER would have given every member the workspace.
    expect(sql).toMatch(/security invoker/);
    expect(sql).not.toMatch(/security definer/);
  });

  it("is stable, so it can be a plain read", () => {
    expect(sql).toMatch(/\bstable\b/);
  });

  it("grants execute to authenticated and to nobody else", () => {
    expect(sql).toMatch(
      /grant execute on function public\.reporting_daily_kpis\(timestamptz, uuid\[\], text\)\s*to authenticated;/,
    );
    expect(sql).not.toMatch(/grant execute[^;]*\banon\b/);
  });
});

describe("the outcome lists match the TypeScript ones", () => {
  it("connected is the same set, exactly", () => {
    const inSql = listAfter("-- CONNECTED_OUTCOMES", "(c.outcome in (");
    expect([...inSql].sort()).toEqual([...CONNECTED_OUTCOMES].sort());
  });

  it("the decision-maker veto list is the same set, exactly", () => {
    // An outcome added to OUTCOME_EXCLUDES_DM but not here lets a mis-flagged
    // gatekeeper count as a decision-maker again — the exact bug that list
    // exists to prevent.
    const inSql = listAfter(
      "-- OUTCOME_EXCLUDES_DM",
      "coalesce(c.outcome, '') not in (",
    );
    expect([...inSql].sort()).toEqual([...OUTCOME_EXCLUDES_DM].sort());
  });
});

describe("it counts what computeDailyKpis counts", () => {
  it("counts goals as distinct businesses per day", () => {
    expect(sql).toMatch(
      /count\(distinct lead_id\) filter \(\s*where outcome = 'goal_met' and lead_id is not null\s*\)::integer as goals/,
    );
  });

  it("requires a CONNECTED call, not just a long one, for a conversation", () => {
    // Duration alone is not a conversation: one looping IVR ran 203 seconds.
    expect(sql).toMatch(
      /count\(\*\) filter \(where connected and over_a_minute\)::integer/,
    );
  });

  it("uses a STRICT greater-than for the one-minute threshold", () => {
    // computeDailyKpis uses `> 60`. analytics_summary uses `>= 60` on a
    // different column; these are genuinely different thresholds and must not
    // be "harmonised" by accident.
    expect(sql).toMatch(/coalesce\(c\.duration_seconds, 0\) > 60/);
    expect(sql).not.toMatch(/coalesce\(c\.duration_seconds, 0\) >= 60/);
  });

  it("does not let a null outcome veto the decision-maker flag", () => {
    // callReachedDm only vetoes when the outcome is non-null AND in the set.
    // `null not in (…)` is NULL, which would drop the row from the count.
    expect(sql).toMatch(/coalesce\(c\.outcome, ''\) not in \(/);
  });

  it("skips rows with no created_at, which have no Eastern day", () => {
    expect(sql).toMatch(/c\.created_at is not null/);
  });

  it("buckets days on the Eastern calendar", () => {
    expect(sql).toMatch(
      /\(c\.created_at at time zone 'America\/New_York'\)::date as et_day/,
    );
  });

  it("returns days newest first, like computeDailyKpis' sort", () => {
    expect(sql).toMatch(/order by d\.et_day desc/);
  });
});

describe("the sentiment lexicon stays in TypeScript", () => {
  it("SQL counts raw values and never decides what is warm", () => {
    // The lexicon lives in field-detect.ts. Copying it into SQL would create a
    // second definition of "warm" to keep in step, for no gain — the counting
    // is the expensive part, not the classification. Asserted against the
    // comment-stripped SQL: the header legitimately explains this in prose.
    expect(code).not.toMatch(/warm/i);
    expect(code).toMatch(/jsonb_object_agg\(sentiment, n\)/);
  });

  it("warmPctOf treats positive and neutral as warm, and nothing else", () => {
    expect(warmPctOf({ yes: 1, maybe: 1, no: 2 })).toBeCloseTo(0.5, 10);
    expect(warmPctOf({ interested: 3 })).toBe(1);
    expect(warmPctOf({ no: 3 })).toBe(0);
  });

  it("warmPctOf returns 0 rather than NaN with no answers", () => {
    expect(warmPctOf({})).toBe(0);
  });

  it("an unrecognised value counts in the denominator, not as warm", () => {
    // Rank 3 (unrecognised) is not warm — but it IS an answer, so it must
    // still dilute the percentage rather than be ignored.
    expect(warmPctOf({ yes: 1, banana: 1 })).toBeCloseTo(0.5, 10);
  });
});

describe("computeDailyKpis remains the specification", () => {
  const call = (over: Partial<Record<string, unknown>> = {}) => ({
    created_at: "2026-09-03T15:00:00Z",
    outcome: "gatekeeper",
    duration_seconds: 10,
    extracted_data: {},
    lead_id: "lead-1",
    ...over,
  });

  it("counts one business once even with two goal-met calls in a day", () => {
    const [day] = computeDailyKpis([
      call({ outcome: "goal_met" }),
      call({ outcome: "goal_met" }),
    ]);
    expect(day.goals).toBe(1);
    expect(day.callsMade).toBe(2);
  });

  it("does not count a mis-flagged gatekeeper as a decision-maker", () => {
    const [day] = computeDailyKpis([
      call({
        outcome: "gatekeeper",
        extracted_data: { decision_maker_reached: "yes" },
      }),
    ]);
    expect(day.dms).toBe(0);
  });

  it("does not count a long voicemail as a conversation", () => {
    const [day] = computeDailyKpis([
      call({ outcome: "voicemail", duration_seconds: 203 }),
    ]);
    expect(day.convGt1min).toBe(0);
  });

  it("needs strictly more than 60 seconds", () => {
    const at = (s: number) =>
      computeDailyKpis([call({ outcome: "callback", duration_seconds: s })])[0]
        .convGt1min;
    expect(at(60)).toBe(0);
    expect(at(61)).toBe(1);
  });
});
