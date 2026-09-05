import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

/**
 * Guards for the pg_cron jobs that drive the app from inside Postgres.
 *
 * Two things went wrong silently and stayed wrong for months:
 *
 *   - Every HTTP cron (dialer tick, smart-list refresh, objection extraction,
 *     Meta sync, best-time refresh) POSTed the throwaway Vercel alias instead
 *     of the canonical host, and used pg_net's 5 s default timeout — which
 *     logged spurious "Timeout of 5000 ms" rows for ticks that had succeeded.
 *   - `expire_resting_leads()` existed but was never scheduled, so a rested
 *     lead never came back; and its body reset next_call_at to now(), which
 *     would have jumped every woken lead to the front of the queue.
 *
 * These read the LATEST migration that (re)schedules each job, the same way
 * dialer-rules.unit.test.ts guards dial_queue, so a future migration that
 * re-creates a job from a stale copy fails here instead of in production.
 */

const MIGRATIONS = "supabase/migrations";
const CANONICAL_HOST = "https://www.smile-and-dial.com";
const LEGACY_ALIAS = "referrizer-smile-and-dial.vercel.app";

function read(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${rel}`, import.meta.url)),
    "utf8",
  );
}

/**
 * SQL with every `-- ...` comment removed, so assertions see what actually
 * runs and not the prose explaining it (which naturally names the old host
 * and the old `now()` behaviour).
 */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** Newest-first list of migration file contents. */
function migrationsNewestFirst(): string[] {
  const dir = fileURLToPath(new URL(`../${MIGRATIONS}`, import.meta.url));
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .reverse()
    .map((f) => read(`${MIGRATIONS}/${f}`));
}

/** The most recent migration that (re)defines `needle`, comments stripped. */
function latestDefining(needle: string): string {
  const hit = migrationsNewestFirst().find((sql) => sql.includes(needle));
  if (!hit) throw new Error(`no migration defines ${needle}`);
  return stripComments(hit);
}

/**
 * The live `cron.schedule('<job>', '<schedule>', $tag$ ... $tag$)` block for a
 * job, from the newest migration that schedules it. A commented-out schedule
 * (`-- select cron.schedule(`) never matches because `\(\s*'` can't cross the
 * `--` prefix on the job-name line.
 */
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

/** Header name -> app_settings column, as the endpoints expect them. */
const HTTP_JOBS = [
  {
    job: "dialer-tick",
    schedule: "* * * * *",
    path: "/api/dialer/tick",
    header: "x-dialer-secret",
    secret: "dialer_tick_secret",
  },
  {
    job: "meta-audience-sync",
    schedule: "0 8 * * *",
    path: "/api/meta/sync",
    header: "x-meta-sync-secret",
    secret: "meta_sync_secret",
  },
  {
    job: "best-time-refresh",
    schedule: "7 8 * * *",
    path: "/api/best-time/refresh",
    header: "x-dialer-secret",
    secret: "dialer_tick_secret",
  },
  {
    job: "smart-lists-refresh",
    schedule: "*/3 * * * *",
    path: "/api/smart-lists/refresh",
    header: "x-dialer-secret",
    secret: "dialer_tick_secret",
  },
  {
    job: "objection-extraction",
    schedule: "*/2 * * * *",
    path: "/api/reporting/objections",
    header: "x-dialer-secret",
    secret: "dialer_tick_secret",
  },
  {
    job: "cost-rates-refresh",
    schedule: "15 4 * * *",
    path: "/api/maintenance/cost-rates",
    header: "x-dialer-secret",
    secret: "dialer_tick_secret",
  },
] as const;

describe.each(HTTP_JOBS)(
  "$job cron",
  ({ job, schedule, path, header, secret }) => {
    const live = latestSchedule(job);

    it("keeps its schedule", () => {
      expect(live.schedule).toBe(schedule);
    });

    it("POSTs the canonical host, never the legacy Vercel alias", () => {
      expect(live.command).toContain(`url := '${CANONICAL_HOST}${path}'`);
      expect(live.command).not.toContain(LEGACY_ALIAS);
    });

    it("sets an explicit 30 s timeout instead of pg_net's 5 s default", () => {
      expect(live.command).toMatch(/timeout_milliseconds := 30000/);
    });

    it("still authenticates with the right secret from app_settings", () => {
      expect(live.command).toContain(`'${header}'`);
      expect(live.command).toContain(
        `(select ${secret} from public.app_settings limit 1), ''`,
      );
    });
  },
);

describe("the legacy Vercel alias is gone from every live cron", () => {
  it("no live SQL after the canonical-host fix still names it", () => {
    // Everything from the fix migration onward (newest first, so take until
    // we reach the fix itself). Comments may still name the alias; code may not.
    const newestFirst = migrationsNewestFirst();
    const fixIdx = newestFirst.findIndex((sql) =>
      sql.includes("Point every HTTP cron at the canonical host"),
    );
    expect(fixIdx).toBeGreaterThanOrEqual(0);
    for (const sql of newestFirst.slice(0, fixIdx + 1)) {
      expect(stripComments(sql)).not.toContain(LEGACY_ALIAS);
    }
  });
});

describe("expire_resting_leads keeps resting leads on schedule", () => {
  const sql = latestDefining(
    "create or replace function public.expire_resting_leads",
  );

  it("wakes only overdue, non-deleted resting leads", () => {
    expect(sql).toMatch(/where status = 'resting'/);
    expect(sql).toContain("and resting_until is not null");
    expect(sql).toContain("and resting_until <= now()");
    expect(sql).toContain("and deleted_at is null");
  });

  it("returns the lead to ready_to_call, due when its rest ended", () => {
    expect(sql).toContain("set status = 'ready_to_call'");
    expect(sql).toMatch(/next_call_at = resting_until/);
    // NOT now(): that would put every woken lead at the head of the queue at
    // once, regardless of when its rest actually ended.
    expect(sql).not.toMatch(/next_call_at = now\(\)/);
    expect(sql).toMatch(/resting_until = null/);
  });

  it("stays a security-definer function pinned to public", () => {
    expect(sql).toContain("security definer");
    expect(sql).toContain("set search_path = public");
    expect(sql).toContain("returns integer");
  });

  it("does not widen execute grants (the cron runs as postgres)", () => {
    expect(sql).not.toMatch(
      /grant execute on function public\.expire_resting_leads/,
    );
  });

  it("is actually scheduled, every 30 minutes", () => {
    const live = latestSchedule("expire-resting-leads");
    expect(live.schedule).toBe("*/30 * * * *");
    expect(live.command).toContain("select public.expire_resting_leads();");
  });
});
