import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * One lead list's performance row.
 *
 * `list_id` / `list_name` are deliberately nullable, which is STRICTER than the
 * generated `Database` type says. Supabase's type generator cannot infer
 * nullability for a function's `RETURNS TABLE` columns, so it types every one
 * of them non-null — but `list_performance` returns one extra row with a null
 * id for registrations that could not be traced back to a lead, and the same is
 * true of `first_call` / `last_call` on a list that has never been dialled. Do
 * not "correct" these to match the generated type.
 */
export type ListPerformanceRow = {
  /** Null on the single "Unattributed" row — registrations with no lead. */
  list_id: string | null;
  list_name: string | null;
  is_inbound: boolean;
  /** Live leads in the list right now. Never date-filtered — see the migration. */
  leads: number;
  /** Distinct live leads dialled at least once inside the filter. */
  worked: number;
  calls: number;
  connected: number;
  /** Distinct businesses whose decision-maker we reached. */
  dms: number;
  /** Distinct businesses that hit the goal — never goal-met calls (#279). */
  goals: number;
  regs: number;
  attended: number;
  sales: number;
  spend: number;
  first_call: string | null;
  last_call: string | null;
};

export type ListPerformanceFilters = {
  /** ET day, inclusive. Null on both ends means all time. */
  from?: string | null;
  to?: string | null;
  campaignId?: string | null;
  ownerId?: string | null;
};

/**
 * Per-list performance rows, best first.
 *
 * The RPC is SECURITY INVOKER, so the CALLER's row-level security decides which
 * lists are counted: a super admin sees every list, everyone else sees their
 * own. That is the whole access model for this section — deliberately no second
 * check in application code, because a UI check that disagrees with RLS is how
 * data leaks.
 *
 * No pagination needed: one row per list, not per call, so PostgREST's 1,000-row
 * cap is nowhere near — which is the entire reason the counting happens in SQL.
 */
export async function fetchListPerformance(
  supabase: SupabaseClient,
  filters: ListPerformanceFilters = {},
): Promise<ListPerformanceRow[]> {
  const { data, error } = await supabase.rpc("list_performance", {
    p_start: filters.from ?? undefined,
    p_end: filters.to ?? undefined,
    p_campaign: filters.campaignId ?? undefined,
    p_owner: filters.ownerId ?? undefined,
  });
  if (error) throw new Error(`list_performance: ${error.message}`);
  return ((data ?? []) as ListPerformanceRow[]).map((r) => ({
    ...r,
    // numeric comes back as a string from PostgREST; everything downstream
    // does arithmetic on it.
    spend: Number(r.spend),
  }));
}

/**
 * How much of the list has been dialled at all, or null when the share would be
 * meaningless.
 *
 * This is the column that stops the table lying. A list that "converts badly"
 * is usually a list that is 8% worked, and without this beside every rate the
 * two are indistinguishable.
 *
 * Null — rendered as an em dash — for a list with no live leads, which is the
 * unattributed row and any list whose leads have all been deleted.
 */
export function workedShare(row: ListPerformanceRow): number | null {
  if (row.leads <= 0) return null;
  return row.worked / row.leads;
}

/**
 * Businesses that hit the goal, over businesses actually dialled.
 *
 * Measured against `worked` rather than `leads` on purpose: a list you have
 * only started must not be scored as though you had finished it. Null while
 * nothing has been dialled, so a fresh import reads as "—" rather than 0%.
 */
export function conversionRate(row: ListPerformanceRow): number | null {
  if (row.worked <= 0) return null;
  return row.goals / row.worked;
}

/** True for the single synthetic row carrying registrations with no lead. */
export function isUnattributed(row: ListPerformanceRow): boolean {
  return row.list_id === null;
}

/**
 * Column totals for the table's footer.
 *
 * Counts are summed; the rates are recomputed from the summed parts rather than
 * averaged, because an average of per-list percentages weights a 42-lead list
 * the same as an 84,000-lead one.
 */
export function totalsFor(rows: readonly ListPerformanceRow[]): {
  leads: number;
  worked: number;
  calls: number;
  connected: number;
  dms: number;
  goals: number;
  regs: number;
  attended: number;
  sales: number;
  spend: number;
} {
  const acc = {
    leads: 0,
    worked: 0,
    calls: 0,
    connected: 0,
    dms: 0,
    goals: 0,
    regs: 0,
    attended: 0,
    sales: 0,
    spend: 0,
  };
  for (const r of rows) {
    acc.leads += r.leads;
    acc.worked += r.worked;
    acc.calls += r.calls;
    acc.connected += r.connected;
    acc.dms += r.dms;
    acc.goals += r.goals;
    acc.regs += r.regs;
    acc.attended += r.attended;
    acc.sales += r.sales;
    acc.spend += r.spend;
  }
  return acc;
}
