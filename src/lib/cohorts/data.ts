import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import { etDateDaysAgo, etDayString } from "@/lib/time/eastern";

type DB = SupabaseClient<Database>;

/**
 * One cohort row.
 *
 * `last_session` is deliberately `string | null`, which is STRICTER than the
 * generated `Database` type says. Supabase's type generator cannot infer
 * nullability for a function's `RETURNS TABLE` columns, so it types every one
 * of them non-null — but `last_session` is `max(scheduled_at)` reached through
 * a LEFT JOIN, and a dial day that produced no registrations really does come
 * back NULL. Do not "correct" this to match the generated type; `isRipe()`
 * depends on the null case.
 */
export type CohortRow = {
  dial_day: string;
  calls: number;
  connected: number;
  dms: number;
  regs: number;
  attended: number;
  no_show: number;
  rescheduled: number;
  sales: number;
  spend: number;
  pending: number;
  last_session: string | null;
};

/** How many ET days the Cohorts tab looks back. Also the window the rolling
 *  show/close rates are computed over. */
export const COHORT_WINDOW_DAYS = 30;

/**
 * Cohort rows for the last `COHORT_WINDOW_DAYS` ET days, newest first.
 *
 * The RPC is SECURITY INVOKER, so the CALLER's row-level security decides which
 * leads are counted: an admin sees everything, a member sees only leads they
 * own. That is the whole access model for this tab — there is no second check
 * in application code, deliberately, because a UI check that disagrees with RLS
 * is how data leaks.
 *
 * Takes its client rather than building one, the same convention as
 * agent-analytics/report-data.ts: the in-app page passes an auth client and the
 * public token-gated share passes a service-role one, and the SAME query and
 * mapping serve both so the two surfaces cannot drift.
 *
 * `campaignIds` scopes calls, spend AND registrations to those campaigns —
 * empty or omitted means every campaign. It has to be passed wherever
 * `reporting_daily_kpis` is scoped, because the Daily tab puts the two sources
 * in one row: a scoped call count beside workspace-wide registrations made
 * every $/reg on the page wrong (20260908100000).
 *
 * No pagination needed: the function returns one row per day, not per call, so
 * PostgREST's 1000-row cap is nowhere near.
 */
export async function fetchCohortRows(
  supabase: DB,
  campaignIds?: readonly string[] | null,
): Promise<CohortRow[]> {
  const { data, error } = await supabase.rpc("cohort_rows", {
    p_start: etDateDaysAgo(COHORT_WINDOW_DAYS),
    p_end: etDayString(),
    // undefined, never null: PostgREST then omits the argument and the SQL
    // default (null = all campaigns) applies. The generated Args type models an
    // optional argument as `?: T`, not `T | null` — same reason
    // report-data.ts omits it for reporting_daily_kpis.
    p_campaign_ids: campaignIds?.length ? [...campaignIds] : undefined,
  });
  if (error) throw new Error(`cohort_rows: ${error.message}`);
  return ((data ?? []) as CohortRow[]).map((r) => ({
    ...r,
    // numeric comes back as a string from PostgREST; everything downstream
    // does arithmetic on it.
    spend: Number(r.spend),
  }));
}

// `unmarkedSessions` lived here and had exactly one caller, the Cohorts tab.
// The rule survives as `unmarkedDays` in reporting/daily-view.tsx, restated on
// the joined row it now reads from; keeping a second copy here that nothing
// calls is how two versions of one rule start disagreeing.
