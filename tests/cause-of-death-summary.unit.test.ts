// tests/cause-of-death-summary.unit.test.ts
//
// cause_of_death_summary transcribes assignCause() into SQL. assignCause is an
// ORDERED chain where the first match wins, so the failure mode is not an error
// — it is leads quietly counted as the wrong thing.
//
// These tests pin the two halves a reader cannot check by eye: that the SQL's
// branches appear in the same order as the TypeScript's, and that the status
// and outcome sets inside them are the same members. Several of those sets are
// module-private, so both sides are compared as SOURCE TEXT rather than by
// importing — which also means editing one without the other fails here.
//
// Behavioural parity is checked against production by
// `npm run verify:cause-of-death`, which runs the REAL assignCause against the
// RPC over six windows.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { CAUSE_ORDER, CAUSE_GROUP } from "@/lib/agent-analytics/cause-of-death";

const sql = readFileSync(
  "supabase/migrations/20260907100000_cause_of_death_summary.sql",
  "utf8",
);
const ts = readFileSync("src/lib/agent-analytics/cause-of-death.ts", "utf8");

/** The function body, comments stripped — assertions about what it DOES. */
const body = (() => {
  const open = sql.indexOf("as $$");
  const close = sql.indexOf("$$;", open);
  return sql
    .slice(open, close)
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");
})();

/** Quoted strings inside a named `new Set([...])` in the TypeScript source. */
function tsSet(name: string): string[] {
  const m = new RegExp(
    `${name}\\s*=\\s*new Set(?:<string>)?\\(\\[([^\\]]*)\\]`,
  ).exec(ts);
  expect(m, `TS set not found: ${name}`).not.toBeNull();
  return [...m![1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]).sort();
}

/** Quoted strings in the SQL between `after` and the next `)`. */
function sqlList(after: string): string[] {
  const i = body.indexOf(after);
  expect(i, `SQL fragment not found: ${after}`).toBeGreaterThan(-1);
  const close = body.indexOf(")", i + after.length);
  return [...body.slice(i, close).matchAll(/'([a-z_]+)'/g)]
    .map((x) => x[1])
    .sort();
}

describe("cause_of_death_summary runs as the caller", () => {
  it("is SECURITY INVOKER, never DEFINER", () => {
    expect(sql).toMatch(/security invoker/);
    expect(sql).not.toMatch(/security definer/);
  });

  it("is stable, and granted only to authenticated", () => {
    expect(sql).toMatch(/\bstable\b/);
    expect(sql).toMatch(
      /grant execute on function public\.cause_of_death_summary\(\s*timestamptz, uuid\[\], integer\s*\) to authenticated;/,
    );
    expect(sql).not.toMatch(/grant execute[^;]*\banon\b/);
  });
});

describe("the CASE branches are in assignCause's order", () => {
  // The order IS the algorithm. If `has('not_interested')` were tested before
  // the won branch, a lead that later booked would be counted as a rejection.
  it("evaluates won → opted_out → dm_said_no → callback → in-play → gatekeeper → bad number", () => {
    const order = [...body.matchAll(/then '([a-z_]+)'/g)]
      .map((m) => m[1])
      // The no-contact sub-reason CASE reuses `then '…'`; keep only causes.
      .filter((c) => (CAUSE_ORDER as readonly string[]).includes(c));
    expect(order).toEqual([
      "won",
      "opted_out",
      "dm_said_no",
      "callback_booked",
      "mid_follow_up",
      "gatekeeper",
      "bad_number",
    ]);
    // …and everything unmatched falls through to no_contact.
    expect(body).toMatch(/else 'no_contact'\s*\n\s*end as cause/);
  });

  it("puts the no-contact sub-reasons in noContactReason's precedence", () => {
    const order = [
      ...body.matchAll(/then '(brushed_off|machine|no_pickup|error)'/g),
    ].map((m) => m[1]);
    expect(order).toEqual(["brushed_off", "machine", "no_pickup", "error"]);
  });
});

describe("the status and outcome sets match the TypeScript", () => {
  it("won statuses", () => {
    expect(sqlList("l.status in ('goal_met'")).toEqual(tsSet("WON_STATUSES"));
  });

  it("in-play statuses", () => {
    expect(sqlList("l.status in ('ready_to_call'")).toEqual(
      tsSet("IN_PLAY_STATUSES"),
    );
  });

  it("brushed-off outcomes", () => {
    expect(
      sqlList("'hung_up_immediately', 'hung_up_later', 'call_back_later'"),
    ).toEqual(tsSet("BRUSHED_OFF"));
  });

  it("machine outcomes", () => {
    expect(sqlList("'voicemail', 'ai_receptionist'")).toEqual(tsSet("MACHINE"));
  });

  it("no-pickup outcomes", () => {
    expect(sqlList("'no_answer', 'busy', 'failed'")).toEqual(
      tsSet("NO_PICKUP"),
    );
  });

  it("error outcomes", () => {
    expect(sqlList("'language_barrier', 'ai_error'")).toEqual(tsSet("ERROR"));
  });
});

describe("the gatekeeper branch still requires no decision-maker", () => {
  it("checks the lead flag, not just the outcome", () => {
    // Without this a lead we DID reach the owner on, that also hit a gatekeeper
    // on an earlier call, would be filed under "never got past the front desk".
    expect(body).toMatch(
      /l\.decision_maker_reached is not true and p\.has_gatekeeper/,
    );
  });
});

describe("the company lists are capped and honest", () => {
  it("slices the sample to p_sample", () => {
    expect(body).toMatch(/\[1:greatest\(p_sample, 0\)\]/);
  });

  it("returns the TRUE count alongside every sample", () => {
    // The UI says "N more not shown", which is only possible if the real total
    // travels with the truncated list.
    expect(body).toMatch(/'count', n,\s*'sample', to_jsonb\(sample\)/);
  });

  it("orders the sample deterministically, most recent first", () => {
    expect(body).toMatch(
      /array_agg\(company order by last_call_at desc, company, lead_id\)/,
    );
  });
});

describe("group totals stay derivable from cause counts", () => {
  it("every cause in CAUSE_ORDER has a group", () => {
    // fetchCauseOfDeath sums counts into groups via CAUSE_GROUP; a cause with
    // no group would silently vanish from the three headline tiles.
    for (const c of CAUSE_ORDER) {
      expect(CAUSE_GROUP[c], `no group for ${c}`).toBeDefined();
    }
  });
});
