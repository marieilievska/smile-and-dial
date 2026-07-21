import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

/**
 * Guard for the regression that wiped seven dialer rules at once.
 *
 * `dial_queue` and `pre_call_check` are single database objects: every change
 * rewrites the WHOLE thing. On 2026-07-18 the number-pool work rebuilt both
 * from five-week-old copies to make one small change each, silently deleting
 * everything added in between — callbacks-when-autopilot-off, the mobile lock,
 * the shared-list ownership guard, audience/smart-list targeting, weekend
 * callbacks and cold-dial pacing. Postgres doesn't warn, nothing tested them,
 * and no campaign was auto-dialling, so it went unnoticed for days.
 *
 * These assert that the LATEST definition of each object still contains every
 * rule. If a future migration rebuilds either from a stale base, this fails
 * instead of quietly dropping safety rules on a system that makes real calls.
 */

const MIGRATIONS = "supabase/migrations";

function read(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${rel}`, import.meta.url)),
    "utf8",
  );
}

/** The most recent migration that (re)defines `needle`. */
function latestDefining(needle: string): string {
  const dir = fileURLToPath(new URL(`../${MIGRATIONS}`, import.meta.url));
  const hit = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .reverse()
    .find((f) => read(`${MIGRATIONS}/${f}`).includes(needle));
  if (!hit) throw new Error(`no migration defines ${needle}`);
  return read(`${MIGRATIONS}/${hit}`);
}

describe("dial_queue keeps every rule", () => {
  const sql = latestDefining("create or replace view public.dial_queue");

  it("lets scheduled callbacks run when autopilot is off", () => {
    expect(sql).toMatch(/autopilot_enabled = true or l\.status = 'callback'/);
  });

  it("never AI-dials a mobile", () => {
    expect(sql).toMatch(/line_type is distinct from 'mobile'/);
  });

  it("keeps a lead glued to the campaign that owns it", () => {
    expect(sql).toMatch(
      /owner_campaign_id is null or l\.owner_campaign_id = c\.id/,
    );
  });

  it("still targets by audience search and smart list, not just lists", () => {
    expect(sql).toContain("audience_search");
    expect(sql).toContain("smart_list_members");
  });

  it("gates on the number POOL, not a single campaign number", () => {
    expect(sql).toContain("attached_campaign_id = c.id");
    expect(sql).not.toMatch(/c\.twilio_number_id is not null/);
  });

  it("exempts callbacks from calling hours but not cold leads", () => {
    // Cold outreach keeps the campaign window AND the weekday gate (false).
    expect(sql).toMatch(
      /l\.status = 'callback'\s*\n\s*or public\.is_within_calling_hours/,
    );
    expect(sql).toMatch(/calling_hours_start, c\.calling_hours_end, false/);
  });

  it("still puts callbacks ahead of cold leads", () => {
    expect(sql).toContain("order by q.dial_priority");
  });
});

describe("pre_call_check keeps every rule", () => {
  const sql = latestDefining(
    "create or replace function public.pre_call_check",
  );

  it("blocks AI dialing a mobile", () => {
    expect(sql).toContain("lead_is_mobile");
  });

  it("paces cold dials by dial_interval_seconds", () => {
    expect(sql).toContain("pacing_wait");
    expect(sql).toContain("dial_interval_seconds");
  });

  it("gates on the number pool", () => {
    expect(sql).toContain("campaign_has_no_numbers");
  });

  it("exempts callbacks from calling hours, pacing and volume caps", () => {
    expect(sql).toMatch(
      /v_lead\.status <> 'callback'\s*\n\s*and not public\.is_within_calling_hours/,
    );
    expect(sql).toContain("if v_lead.status <> 'callback' then");
  });

  it("still applies concurrency and spend caps to callbacks", () => {
    // These sit AFTER the callback-exempt block, so they apply to everything.
    const exemptAt = sql.indexOf("if v_lead.status <> 'callback' then");
    expect(sql.indexOf("concurrency_cap_hit")).toBeGreaterThan(exemptAt);
    expect(sql.indexOf("daily_spend_cap_hit")).toBeGreaterThan(exemptAt);
  });
});
