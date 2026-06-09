import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

/**
 * Point a lead's `next_call_at` at its EARLIEST pending callback and keep its
 * status = 'callback' while any pending callback remains.
 *
 * A lead can accumulate more than one pending callback (the agent schedules one
 * on a later call while an earlier one is still pending). The dialer keys off
 * `lead.next_call_at`, so if a *later* callback overwrote it, an earlier —
 * possibly overdue — callback would be stranded and never dialed. Recomputing
 * from MIN(scheduled_at) of the pending callbacks keeps the lead pointed at the
 * soonest one. Call this after inserting/rescheduling/cancelling any callback.
 *
 * Works with any Supabase client (user-scoped or service-role).
 */
export async function syncLeadNextCallToEarliestCallback(
  supabase: SupabaseClient<Database>,
  leadId: string,
): Promise<void> {
  const { data } = await supabase
    .from("callbacks")
    .select("scheduled_at")
    .eq("lead_id", leadId)
    .eq("status", "pending")
    .order("scheduled_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!data) return; // no pending callbacks — leave the lead as-is
  await supabase
    .from("leads")
    .update({ status: "callback", next_call_at: data.scheduled_at })
    .eq("id", leadId);
}
