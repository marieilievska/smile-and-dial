import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards for the silent-stop alerting migrations (20260905200000 +
 * 20260905201000). The evaluator runs as postgres under pg_cron, so nothing
 * in CI ever executes it; these pin the shape a future rewrite must keep —
 * the rule names (they are the notification `kind`s the UI routes on), the
 * dedupe primitive, the periods, the schedule, and the no-grant posture.
 */

const MIGRATIONS = "supabase/migrations";

function read(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${rel}`, import.meta.url)),
    "utf8",
  );
}

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

function migrationsNewestFirst(): string[] {
  const dir = fileURLToPath(new URL(`../${MIGRATIONS}`, import.meta.url));
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .reverse()
    .map((f) => read(`${MIGRATIONS}/${f}`));
}

function latestDefining(needle: string): string {
  const hit = migrationsNewestFirst().find((sql) => sql.includes(needle));
  if (!hit) throw new Error(`no migration defines ${needle}`);
  return stripComments(hit);
}

function latestSchedule(job: string): { schedule: string; command: string } {
  const re = new RegExp(
    String.raw`cron\.schedule\(\s*'${job}',\s*'([^']+)',\s*(\$[a-z]*\$)([\s\S]*?)\2`,
  );
  for (const sql of migrationsNewestFirst()) {
    const m = re.exec(sql);
    if (m) return { schedule: m[1], command: stripComments(m[3]) };
  }
  throw new Error(`no migration schedules ${job}`);
}

/** Rule -> the alert_fire() period literal it must dedupe on. cap_hit_daily
 *  is the exception: its period is "since ET midnight", an expression. */
const RULES: Record<string, string | null> = {
  cap_hit_daily: null,
  cap_hit_hourly: "interval '6 hours'",
  dialer_stalled: "interval '2 hours'",
  pool_exhausted: "interval '6 hours'",
  cron_missed: "interval '6 hours'",
  placement_storm: "interval '1 hour'",
  callbacks_piling_paused: "interval '24 hours'",
  integration_missing: "interval '24 hours'",
  meta_sync_failed: "interval '24 hours'",
  credit_read_failed: "interval '2 hours'",
};

describe("alert_state + alert_fire (the dedupe primitive)", () => {
  const sql = latestDefining("create or replace function public.alert_fire");

  it("keys the state table on (rule, ref_id)", () => {
    expect(sql).toMatch(/create table if not exists public\.alert_state/);
    expect(sql).toMatch(/primary key \(rule, ref_id\)/);
  });

  it("claims atomically: insert ... on conflict ... where the period elapsed", () => {
    expect(sql).toMatch(/insert into public\.alert_state as s/);
    expect(sql).toMatch(/on conflict \(rule, ref_id\) do update/);
    expect(sql).toMatch(/where s\.last_fired_at <= now\(\) - in_period/);
    expect(sql).toMatch(/get diagnostics v_rows = row_count/);
  });

  it("is service-role only: RLS on, no policies, no execute grants", () => {
    expect(sql).toMatch(
      /alter table public\.alert_state enable row level security/,
    );
    expect(sql).toMatch(
      /alter table public\.dialer_heartbeats enable row level security/,
    );
    expect(sql).not.toMatch(/create policy/);
    expect(sql).not.toMatch(/grant execute/);
  });

  it("heartbeat table carries the two new stop signals", () => {
    expect(sql).toMatch(/queue_read_failed boolean not null default false/);
    expect(sql).toMatch(/pool_exhausted_campaigns uuid\[\]/);
    expect(sql).toMatch(/blocked_reasons jsonb/);
  });

  it("adds the composite indexes the evaluator leans on", () => {
    expect(sql).toMatch(
      /calls_campaign_id_created_at_idx\s+on public\.calls \(campaign_id, created_at desc\)/,
    );
    expect(sql).toMatch(
      /system_events_kind_created_at_idx\s+on public\.system_events \(kind, created_at desc\)/,
    );
  });
});

describe("evaluate_alerts()", () => {
  const sql = latestDefining(
    "create or replace function public.evaluate_alerts",
  );

  it("is a security-definer function pinned to public, with no grants", () => {
    expect(sql).toContain("security definer");
    expect(sql).toContain("set search_path = public");
    expect(sql).not.toMatch(/grant execute/);
  });

  it.each(Object.entries(RULES))(
    "rule %s dedupes through alert_fire and emits that kind",
    (rule, period) => {
      const claim = new RegExp(
        String.raw`alert_fire\('${rule}',\s*[^,]+,\s*${
          period ? period.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "[^)]+"
        }\)`,
      );
      expect(sql).toMatch(claim);
      expect(sql).toContain(`'${rule}',`);
    },
  );

  it("cap_hit_daily dedupes on the time since ET midnight, not a fixed interval", () => {
    expect(sql).toMatch(
      /alert_fire\('cap_hit_daily', v_c\.id, now\(\) - v_et_midnight\)/,
    );
    expect(sql).toMatch(/at time zone 'America\/New_York'/);
  });

  it("caps count the same calls pre_call_check counts", () => {
    // direction=outbound, call_mode=ai, status<>failed — twice (daily + hourly)
    const matches = sql.match(
      /k\.direction = 'outbound'\s+and k\.call_mode = 'ai'\s+and k\.status <> 'failed'/g,
    );
    expect(matches?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("dialer_stalled tells 'no tick' from 'ticking but blocked'", () => {
    expect(sql).toMatch(/interval '5 minutes'/);
    expect(sql).toMatch(/interval '15 minutes'/);
    expect(sql).toContain("'no_tick'");
    expect(sql).toContain("'queue error'");
    expect(sql).toContain("'no numbers'");
    expect(sql).toContain("'credits'");
    expect(sql).toContain("Dialer stopped: no tick in %s minutes");
    expect(sql).toContain("Dialer running but nothing is dialing for");
    // Caps are not faults: the stall rule never keys on them.
    expect(sql).toMatch(/jsonb_exists_any\(/);
    expect(sql).not.toMatch(/jsonb_exists_any\([^;]*cap_hit/);
    // Only autopilot campaigns can stall; callbacks (priority 0) are excluded.
    expect(sql).toMatch(/and c\.autopilot_enabled/);
    expect(sql).toMatch(/q\.dial_priority = 1/);
  });

  it("pool_exhausted mirrors selectPoolNumber's usable-number predicate", () => {
    expect(sql).toMatch(/tn\.pool_status = 'active'/);
    expect(sql).toMatch(/tn\.flagged_for_rotation = false/);
    expect(sql).toMatch(/tn\.elevenlabs_phone_number_id is not null/);
    expect(sql).toMatch(
      /\(tn\.rested_until is null or tn\.rested_until <= now\(\)\)/,
    );
  });

  it("cron_missed uses 3x the interval, 26 h for daily jobs, and notifies admins", () => {
    expect(sql).toMatch(/make_interval\(mins => 3 \* v_minutes\)/);
    expect(sql).toMatch(/when v_minutes >= 1440 then interval '26 hours'/);
    expect(sql).toMatch(/v_last\.status = 'failed'/);
    expect(sql).toMatch(/md5\(v_j\.jobname\)::uuid/);
    expect(sql).toMatch(/where p\.role = 'admin' and p\.active/);
  });

  it("placement_storm: >= 20 call_placement_failed in 10 minutes", () => {
    expect(sql).toMatch(/e\.kind = 'call_placement_failed'/);
    expect(sql).toMatch(/interval '10 minutes'/);
    expect(sql).toMatch(/having count\(\*\) >= 20/);
  });

  it("callbacks_piling_paused: >= 5 overdue pending callbacks on a paused campaign", () => {
    expect(sql).toMatch(/cb\.status = 'pending'/);
    expect(sql).toMatch(/cb\.scheduled_at < now\(\)/);
    expect(sql).toMatch(/c\.status = 'paused'/);
    expect(sql).toMatch(/having count\(cb\.id\) >= 5/);
  });

  it("integration_missing mirrors campaignIntegrationRequirements()", () => {
    for (const tool of [
      "get_available_times",
      "book_appointment",
      "send_email",
      "send_text",
    ]) {
      expect(sql).toContain(`v_tools->'${tool}' = 'true'::jsonb`);
    }
    expect(sql).toMatch(/v_c\.fixed_time_booking is true/);
    expect(sql).toMatch(/calendly_event_id/);
    expect(sql).toMatch(/calendly_api_key/);
    expect(sql).toMatch(/close_api_key/);
  });

  it("meta_sync_failed: last run within 26 h recorded an error", () => {
    expect(sql).toMatch(/ui\.meta_last_sync_error is not null/);
    expect(sql).toMatch(
      /ui\.meta_last_sync_at > now\(\) - interval '26 hours'/,
    );
  });

  it("credit_read_failed: read failing AND last good reading past the 15-min window", () => {
    expect(sql).toMatch(/v_credit\.read_error_logged_at is not null/);
    expect(sql).toMatch(
      /v_credit\.checked_at < now\(\) - interval '15 minutes'/,
    );
  });

  it("every rule is isolated in its own exception block", () => {
    const blocks = sql.match(/exception when others then/g) ?? [];
    expect(blocks.length).toBe(Object.keys(RULES).length);
  });

  it("is scheduled every 5 minutes as alerts-evaluate", () => {
    const live = latestSchedule("alerts-evaluate");
    expect(live.schedule).toBe("*/5 * * * *");
    expect(live.command).toContain("select public.evaluate_alerts();");
  });
});

describe("cron_schedule_minutes()", () => {
  const sql = latestDefining(
    "create or replace function public.cron_schedule_minutes",
  );

  it("is immutable, pinned to public, and defaults unknown forms to daily", () => {
    expect(sql).toContain("immutable");
    expect(sql).toContain("set search_path = public");
    expect(sql).toMatch(/else 1440/);
  });

  it("recognises the every-N-minutes form the jobs actually use", () => {
    expect(sql).toMatch(String.raw`^\s*\*/\d+(\s+\*){4}\s*$`);
    expect(sql).toMatch(String.raw`^\s*\*(\s+\*){4}\s*$`);
  });
});
