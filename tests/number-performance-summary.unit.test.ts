// tests/number-performance-summary.unit.test.ts
//
// number_performance_summary counts the Numbers tab's connect rates in SQL.
// The counting itself is simple; what is easy to get wrong is everything
// around it, and each mistake produces a plausible wrong number rather than an
// error:
//
//   * the CONNECTED list drifting from CONNECTED_OUTCOMES, so this tab's
//     Connect column disagrees with every other connect rate on the screen
//     (exactly the bug 20260903233000 was written to fix);
//   * `outcome <> 'ai_error'` instead of `coalesce(outcome, '') <> 'ai_error'`,
//     which is NULL — and so false — for a call with no outcome yet, silently
//     dropping every one of them;
//   * dropping ai_error from the numerator but leaving it in the denominator,
//     which lets an ElevenLabs credit outage tank a number's rate;
//   * one shared null filter instead of one per grouping, which would let
//     jsonb_object_agg throw on a null key — or, worse, count a call with no
//     twilio_number_id toward a tier it does belong to and then not.
//
// Behavioural parity against production is checked separately by
// `npm run verify:numbers`, which runs the JavaScript this replaced.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { CONNECTED_OUTCOMES, NON_CALL_OUTCOMES } from "@/lib/calls/outcomes";

const sql = readFileSync(
  "supabase/migrations/20260907110000_number_performance_summary.sql",
  "utf8",
);

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

/** The quoted values of the `in (...)` list that follows a marker comment. */
function outcomeList(marker: string): string[] {
  const i = sql.indexOf(marker);
  expect(i, `marker not found: ${marker}`).toBeGreaterThan(-1);
  const open = sql.indexOf("(", sql.indexOf("in (", i));
  const close = sql.indexOf(")", open);
  return [...sql.slice(open, close).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe("the connected list mirrors CONNECTED_OUTCOMES", () => {
  it("has exactly the same members", () => {
    // Both halves matter. An outcome added to CONNECTED_OUTCOMES but not here
    // undercounts connections; one added here but not there overcounts them.
    expect(outcomeList("-- CONNECTED_OUTCOMES").sort()).toEqual(
      [...CONNECTED_OUTCOMES].sort(),
    );
  });

  it("never counts ai_error as a connection", () => {
    expect(CONNECTED_OUTCOMES.has("ai_error")).toBe(false);
    expect(outcomeList("-- CONNECTED_OUTCOMES")).not.toContain("ai_error");
  });
});

describe("ai_error leaves the denominator too", () => {
  it("filters it out in the base scan, before any grouping", () => {
    // In the WHERE clause, so the row is gone from calls AND connected — the
    // JS `if (c.outcome === 'ai_error') continue`.
    expect(body).toMatch(
      /where[\s\S]*coalesce\(c\.outcome, ''\) <> 'ai_error'/,
    );
  });

  it("uses coalesce, so a call with no outcome yet still counts", () => {
    // `c.outcome <> 'ai_error'` is NULL for a null outcome, and a WHERE clause
    // drops NULL rows. That would quietly delete every in-flight call.
    expect(body).not.toMatch(/\bc\.outcome <> 'ai_error'/);
  });

  it("excludes exactly NON_CALL_OUTCOMES, no more and no less", () => {
    expect([...NON_CALL_OUTCOMES]).toEqual(["ai_error"]);
  });
});

describe("each grouping skips its own null key", () => {
  // 23 outbound calls carry no local_match and 22 no twilio_number_id, and
  // they are not the same rows — so this cannot be one shared filter.
  it.each([
    ["local_match", "by_match"],
    ["dest_country", "by_country"],
    ["twilio_number_id", "by_number"],
  ])("%s", (column) => {
    expect(body).toMatch(
      new RegExp(`where ${column} is not null\\s*\\n\\s*group by ${column}`),
    );
  });
});

describe("it returns components, not ratios", () => {
  it("emits only calls and connected per key", () => {
    // Every jsonb_build_object in the body is either the outer wrapper (whose
    // first key is byMatch) or one of the three {calls, connected} pairs. No
    // 'rate', no 'lift' — those are TypeScript's, next to the component that
    // draws them.
    const firstKeys = [
      ...body.matchAll(/jsonb_build_object\(\s*\n?\s*'([A-Za-z]+)'/g),
    ].map((m) => m[1]);
    expect(new Set(firstKeys)).toEqual(new Set(["byMatch", "calls"]));
    expect(firstKeys.filter((k) => k === "calls")).toHaveLength(3);
    expect(body).not.toMatch(/'rate'|'lift'|::numeric/);
  });

  it("returns all three sections, defaulting to {} rather than null", () => {
    for (const k of ["byMatch", "byCountry", "byNumber"]) {
      expect(body).toContain(`'${k}', coalesce(`);
    }
    expect([...body.matchAll(/'\{\}'::jsonb/g)]).toHaveLength(3);
  });
});

describe("it runs as the caller and only for signed-in users", () => {
  it("is SECURITY INVOKER, never DEFINER", () => {
    expect(sql).toMatch(/security invoker/);
    expect(sql).not.toMatch(/security definer/);
  });

  it("is stable, and granted only to authenticated", () => {
    expect(sql).toMatch(/\bstable\b/);
    expect(sql).toMatch(
      /grant execute on function public\.number_performance_summary\(timestamptz\)\s*\n?\s*to authenticated;/,
    );
    // The ROLES after `to`, not the whole statement — `public.` in the
    // schema-qualified name is not a grant to PUBLIC.
    const roles = [
      ...sql.matchAll(/grant\s+execute\s+on[\s\S]*?\s+to\s+([^;]+);/gi),
    ].map((m) => m[1].replace(/\s+/g, " ").trim());
    expect(roles).toEqual(["authenticated"]);
  });

  it("only ever reads outbound calls", () => {
    expect(body).toMatch(/c\.direction = 'outbound'/);
  });
});
