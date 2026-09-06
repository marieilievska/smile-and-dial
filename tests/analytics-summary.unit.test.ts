// tests/analytics-summary.unit.test.ts
//
// analytics_summary re-implements, in SQL, counting rules that also exist in
// TypeScript (src/lib/analytics/stats.ts). Two implementations of the same
// rules is where they quietly drift, so these tests read the migration text
// and pin the parts that would go wrong silently.
//
// What this CANNOT do is run the SQL. Behavioural parity is checked against
// production by `node --env-file=.env.local scripts/verify-analytics-parity.mjs`,
// which runs both paths over five windows and diffs every number.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  CONNECTED_OUTCOMES,
  CONVERSATION_OUTCOMES,
} from "@/lib/calls/outcomes";
import { deriveKpis, FUNNEL_LABELS } from "@/lib/analytics/stats";

const sql = readFileSync(
  "supabase/migrations/20260906081000_analytics_summary_funnel_fold.sql",
  "utf8",
);

/** Pull the quoted outcomes out of one labelled `(c.outcome in (…))` block. */
function outcomeList(marker: string): Set<string> {
  const start = sql.indexOf(marker);
  expect(start, `marker not found: ${marker}`).toBeGreaterThan(-1);
  const open = sql.indexOf("(c.outcome in (", start);
  const close = sql.indexOf("))", open);
  return new Set(
    [...sql.slice(open, close).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]),
  );
}

describe("analytics_summary runs as the caller", () => {
  it("is SECURITY INVOKER, never DEFINER", () => {
    // The old code read calls and leads through the signed-in user's client,
    // so RLS scoped a member to their own rows. DEFINER would hand every
    // member the whole workspace's analytics.
    expect(sql).toMatch(/security invoker/);
    expect(sql).not.toMatch(/security definer/);
  });

  it("is stable, so it can be a plain read", () => {
    expect(sql).toMatch(/\bstable\b/);
  });

  it("grants execute to authenticated and to nobody else", () => {
    expect(sql).toMatch(
      /grant execute on function public\.analytics_summary\(\s*timestamptz, timestamptz, uuid, uuid, uuid\s*\) to authenticated;/,
    );
    expect(sql).not.toMatch(/grant execute[^;]*\banon\b/);
  });
});

describe("the outcome lists match the TypeScript ones", () => {
  it("connected is the same set, exactly", () => {
    // Both halves matter. An outcome added to CONNECTED_OUTCOMES but not here
    // makes Analytics' connect rate quietly lower than every other page's;
    // added here but not there, quietly higher.
    expect([...outcomeList("-- CONNECTED_OUTCOMES")].sort()).toEqual(
      [...CONNECTED_OUTCOMES].sort(),
    );
  });

  it("conversation is the same set, exactly", () => {
    expect([...outcomeList("-- CONVERSATION_OUTCOMES")].sort()).toEqual(
      [...CONVERSATION_OUTCOMES].sort(),
    );
  });
});

describe("it counts what the rest of the app counts", () => {
  it("counts goals as distinct businesses, never goal-met calls", () => {
    // The app-wide rule (#279): two goal-met calls on one business is one goal.
    expect(sql).toMatch(
      /count\(distinct lead_id\) filter \(where goal_met\)::integer as lead_goal/,
    );
  });

  it("takes decision-maker from the LEAD, not the call's extraction", () => {
    // rowReachedDm reads the operator-correctable lead flag. Reading the
    // call's frozen AI extraction would ignore manual Yes/No corrections.
    expect(sql).toMatch(/\(l\.decision_maker_reached is true\) as dm/);
  });

  it("uses call_cost_total, the one definition of what a call cost", () => {
    expect(sql).toMatch(/public\.call_cost_total\(c\.cost_breakdown\) as cost/);
  });

  it("buckets days on the Eastern calendar, like every other surface", () => {
    expect(sql).toMatch(
      /\(c\.created_at at time zone 'America\/New_York'\)::date as et_day/,
    );
  });

  it("falls back to duration when talk time is missing", () => {
    // ElevenLabs never populates talk_time_seconds. Without the fallback this
    // reads 0 for every call — the "Conversations: 0" bug.
    expect(sql).toMatch(
      /coalesce\(c\.talk_time_seconds, c\.duration_seconds, 0\) >= 60/,
    );
  });
});

describe("the funnel is folded in SQL, because it cannot be folded later", () => {
  // |A ∪ B| is not a function of |A| and |B|, so returning raw stage counts
  // would make the folded funnel unrecoverable by the page. Each folded stage
  // has to carry the shallower stages' predicates.
  it("connected folds in goals and decision-makers", () => {
    expect(sql).toMatch(
      /where connected or goal_met or dm\s*\)::integer as funnel_connected/,
    );
  });

  it("conversation folds in goals and decision-makers", () => {
    expect(sql).toMatch(
      /where \(connected and talked_a_minute\) or goal_met or dm\s*\)::integer as funnel_conversation/,
    );
  });

  it("returns no un-folded stage counts to be displayed by mistake", () => {
    // Two similarly-named counts where only one is correct to show is how the
    // wrong one ends up on the page.
    expect(sql).not.toMatch(/as lead_connected\b/);
    expect(sql).not.toMatch(/as lead_conversation\b/);
  });
});

describe("deriveKpis owns every ratio", () => {
  // The SQL deliberately returns sums and counts only. If a ratio were also
  // computed there, the two would eventually disagree.
  it("computes no rates in SQL", () => {
    expect(sql).not.toMatch(/connect_rate|goal_met_rate|avg_duration/);
  });

  it("keeps ai_error out of the connect-rate denominator", () => {
    // An ElevenLabs credit outage must neither inflate nor tank connect rate.
    const withOutage = deriveKpis({
      totalCalls: 200,
      connected: 50,
      aiError: 100,
      conversations: 0,
      dmsReached: 0,
      goalMet: 0,
      goalMetWithDm: 0,
      durationSum: 0,
      durationCount: 0,
      spend: 0,
      callbacksScheduled: 0,
      dncAdditions: 0,
    });
    // 50 of the 100 real calls, not 50 of 200.
    expect(withOutage.connectRate).toBeCloseTo(0.5, 10);
  });

  it("never divides by zero", () => {
    const empty = deriveKpis({
      totalCalls: 0,
      connected: 0,
      aiError: 0,
      conversations: 0,
      dmsReached: 0,
      goalMet: 0,
      goalMetWithDm: 0,
      durationSum: 0,
      durationCount: 0,
      spend: 0,
      callbacksScheduled: 0,
      dncAdditions: 0,
    });
    for (const v of [
      empty.connectRate,
      empty.goalMetRate,
      empty.avgDurationSeconds,
      empty.avgCostPerCall,
      empty.costPerGoalMet,
    ]) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBe(0);
    }
  });

  it("an all-ai_error window reports a 0 rate, not NaN", () => {
    const outage = deriveKpis({
      totalCalls: 40,
      connected: 0,
      aiError: 40,
      conversations: 0,
      dmsReached: 0,
      goalMet: 0,
      goalMetWithDm: 0,
      durationSum: 0,
      durationCount: 0,
      spend: 1.5,
      callbacksScheduled: 0,
      dncAdditions: 0,
    });
    expect(outage.connectRate).toBe(0);
  });
});

describe("the funnel labels are shared", () => {
  it("has four stages, ending at decision-makers", () => {
    expect(FUNNEL_LABELS).toHaveLength(4);
    expect(FUNNEL_LABELS[3]).toBe("Decision-makers reached");
  });
});
