import "server-only";

import { createClient } from "@/lib/supabase/server";
import { etDateDaysAgo, etDayString } from "@/lib/time/eastern";

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
 * Cohort rows for the last `days` ET days, newest first.
 *
 * The RPC is SECURITY INVOKER, so the CALLER's row-level security decides which
 * leads are counted: an admin sees everything, a member sees only leads they
 * own. That is the whole access model for this tab — there is no second check
 * in application code, deliberately, because a UI check that disagrees with RLS
 * is how data leaks.
 *
 * No pagination needed: the function returns one row per day, not per call, so
 * PostgREST's 1000-row cap is nowhere near.
 */
export async function fetchCohortRows(
  days: number = COHORT_WINDOW_DAYS,
): Promise<CohortRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("cohort_rows", {
    p_start: etDateDaysAgo(days),
    p_end: etDayString(),
  });
  if (error) throw new Error(`cohort_rows: ${error.message}`);
  return ((data ?? []) as CohortRow[]).map((r) => ({
    ...r,
    // numeric comes back as a string from PostgREST; everything downstream
    // does arithmetic on it.
    spend: Number(r.spend),
  }));
}

/** Sessions that reconciled with nobody marked attended — almost always a day
 *  the operator forgot rather than a session literally nobody attended. Without
 *  surfacing this, forgetting looks identical to a genuine 0% show rate. */
export function unmarkedSessions(
  rows: readonly CohortRow[],
): { dial_day: string; regs: number }[] {
  return rows
    .filter((r) => r.regs > 0 && r.attended === 0 && r.no_show > 0)
    .map((r) => ({ dial_day: r.dial_day, regs: r.no_show }));
}
