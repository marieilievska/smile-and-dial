import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards for the cost SQL — the same "read the LATEST migration that defines
 * X" approach as cron-jobs.unit.test.ts, so a future migration that recreates
 * one of these from a stale copy fails here instead of in production.
 *
 *   - refresh_cost_rollup must count goal_leads as DISTINCT businesses (the
 *     Costs page counted goal_met CALLS while every other page counts leads)
 *     and must price through call_cost_total() (the one SQL definition).
 *   - monitor_campaign_spend_caps must measure the EASTERN day/month (it used
 *     UTC midnight), price through call_cost_total() (it read the stale stored
 *     total), and auto-resume the campaigns it paused.
 *   - the stale-total backfill must only touch itemized rows.
 */

const MIGRATIONS = "supabase/migrations";
const ET_DAY_START = "date_trunc('day', now() at time zone 'America/New_York')";
const ET_MONTH_START =
  "date_trunc('month', now() at time zone 'America/New_York')";

function read(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${rel}`, import.meta.url)),
    "utf8",
  );
}

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

function migrationsNewestFirst(): { name: string; sql: string }[] {
  const dir = fileURLToPath(new URL(`../${MIGRATIONS}`, import.meta.url));
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .reverse()
    .map((f) => ({ name: f, sql: read(`${MIGRATIONS}/${f}`) }));
}

function latestDefining(needle: string): string {
  const hit = migrationsNewestFirst().find(({ sql }) => sql.includes(needle));
  if (!hit) throw new Error(`no migration defines ${needle}`);
  return stripComments(hit.sql);
}

describe("call_cost_total mirrors breakdownTotal()", () => {
  const sql = latestDefining(
    "create or replace function public.call_cost_total",
  );

  it("sums exactly the five component keys", () => {
    const comps = latestDefining(
      "create or replace function public.call_cost_components",
    );
    for (const k of [
      "twilio",
      "elevenlabs",
      "openai",
      "openai_review",
      "lookup",
    ]) {
      expect(comps).toContain(`public.j_num(j, '${k}')`);
    }
    // Sub-parts and credits are never summed.
    for (const k of ["twilio_call", "twilio_media_stream", "elevenlabs_llm"]) {
      expect(comps).not.toContain(`public.j_num(j, '${k}')`);
    }
  });

  it("falls back to the stored total only when there are no components", () => {
    expect(sql).toMatch(
      /when public\.call_cost_components\(j\) > 0 then public\.call_cost_components\(j\)\s*else public\.j_num\(j, 'total'\)/,
    );
  });
});

describe("refresh_cost_rollup", () => {
  const sql = latestDefining(
    "create or replace function public.refresh_cost_rollup",
  );

  it("counts goal_leads as DISTINCT businesses, alongside goal_met calls", () => {
    expect(sql).toContain("goal_leads");
    expect(sql).toContain(
      "count(distinct c.lead_id) filter (where c.goal_met)",
    );
    expect(sql).toContain("count(*) filter (where c.goal_met)");
  });

  it("prices every call through call_cost_total()", () => {
    expect(sql).toContain("sum(public.call_cost_total(c.cost_breakdown))");
  });

  it("stays a security-definer function on the ET calendar day", () => {
    expect(sql).toContain("security definer");
    expect(sql).toContain(
      "(c.created_at at time zone 'America/New_York')::date",
    );
  });

  it("tolerates a NULL campaign_id (deleted campaign) in the rollup grain", () => {
    const shape = latestDefining("cost_rollup_daily_grain_idx");
    expect(shape).toMatch(/alter column campaign_id drop not null/);
    expect(shape).toMatch(
      /coalesce\(campaign_id, '00000000-0000-0000-0000-000000000000'::uuid\)/,
    );
  });
});

describe("monitor_campaign_spend_caps", () => {
  const sql = latestDefining(
    "create or replace function public.monitor_campaign_spend_caps",
  );

  it("measures the Eastern day and month, never UTC midnight", () => {
    expect(sql).toContain(ET_DAY_START);
    expect(sql).toContain(ET_MONTH_START);
    expect(sql).not.toMatch(/date_trunc\('day', now\(\)\)/);
    expect(sql).not.toMatch(/date_trunc\('month', now\(\)\)/);
  });

  it("prices through call_cost_total(), never the stored total", () => {
    expect(sql).toContain("public.call_cost_total(cost_breakdown)");
    expect(sql).not.toContain("(cost_breakdown->>'total')::numeric");
  });

  it("auto-resumes only the campaigns it paused, and notifies the owner", () => {
    expect(sql).toContain(
      "and paused_reason in ('daily_spend_cap', 'monthly_spend_cap')",
    );
    expect(sql).toMatch(
      /set status = 'active',\s*paused_at = null,\s*paused_reason = null/,
    );
    expect(sql).toContain("'campaign_auto_resumed'");
    // Never touches manual / low_credits / auto pauses.
    expect(sql).not.toMatch(/paused_reason = 'manual'/);
    expect(sql).not.toMatch(/paused_reason = 'low_credits'/);
  });

  it("still pauses on a hit and keeps the original notification kind", () => {
    expect(sql).toContain("'campaign_auto_paused'");
    expect(sql).toContain("v_reason := 'daily_spend_cap'");
    expect(sql).toContain("v_reason := 'monthly_spend_cap'");
  });

  it("does not widen execute grants (post lock-down)", () => {
    expect(sql).not.toMatch(
      /grant execute on function public\.monitor_campaign_spend_caps/,
    );
  });
});

describe("stale-total backfill", () => {
  const sql = stripComments(
    read(`${MIGRATIONS}/20260905183000_backfill_cost_totals.sql`),
  );

  it("only rewrites itemized rows whose stored total drifted", () => {
    expect(sql).toContain("public.call_cost_components(c.cost_breakdown) > 0");
    expect(sql).toMatch(/jsonb_set\(\s*c\.cost_breakdown,\s*'\{total\}'/);
    expect(sql).toContain("select public.refresh_cost_rollup(null);");
  });
});
