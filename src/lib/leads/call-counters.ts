import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { CONVERSATION_OUTCOMES } from "@/lib/calls/outcomes";
import type { Database } from "@/lib/supabase/database.types";
import { fetchAllRows } from "@/lib/supabase/fetch-all-rows";

/** The per-lead counters the Leads table and lead page show ("Attempts",
 *  "Conversations"), derived from the lead's `calls` rows. */
export type LeadCallCounters = {
  /** Every call row on the lead — outbound, inbound, failed, all of it. */
  call_attempts: number;
  /** Calls whose outcome is a real two-way conversation. */
  conversations: number;
};

/** Pure: count the two lead counters from a list of the lead's call outcomes. */
export function countLeadCalls(
  calls: { outcome: string | null }[],
): LeadCallCounters {
  return {
    call_attempts: calls.length,
    conversations: calls.filter(
      (c) => c.outcome !== null && CONVERSATION_OUTCOMES.has(c.outcome),
    ).length,
  };
}

/**
 * Recompute one lead's `call_attempts` / `conversations` from its calls table
 * rows and write them back. The ONE place these counters are derived — every
 * path that adds, moves, relabels, or fails a call must call this, or the lead
 * drifts. (Found on 2026-09-03: inbound call-initiation failures, the inbound
 * lead merge, and the audit relabel script all skipped it.)
 */
export async function syncLeadCallCounters(
  supabase: SupabaseClient<Database>,
  leadId: string,
): Promise<LeadCallCounters> {
  const calls = await fetchAllRows<{ outcome: string | null }>((from, to) =>
    supabase
      .from("calls")
      .select("outcome")
      .eq("lead_id", leadId)
      .order("id", { ascending: true })
      .range(from, to),
  );
  const counters = countLeadCalls(calls);
  await supabase.from("leads").update(counters).eq("id", leadId);
  return counters;
}
