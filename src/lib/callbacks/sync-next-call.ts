import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

type CallOutcome = Database["public"]["Tables"]["calls"]["Row"]["outcome"];

/**
 * Non-connect outcomes: the call never reached a live person — a machine
 * answered (voicemail), nobody picked up (no_answer), the line was busy, the
 * carrier failed it, the number was invalid, or whoever answered hung up before
 * a word was exchanged. A scheduled callback that lands on one of THESE was not
 * actually fulfilled, so it must stay `pending` for the voicemail-escalation
 * ladder (retry +30min → next day → mark 'missed') to run.
 *
 * Everything NOT in this set is treated as "we reached someone / made a live
 * attempt that consumes the callback" — goal_met, callback, call_back_later,
 * not_interested, dm_reached, gatekeeper, transferred_to_human, ai_receptionist,
 * language_barrier, dnc — and completes the due callback. (Per the issue brief:
 * when unsure about gatekeeper/language_barrier, only the clear non-connects
 * below leave the callback pending; every other outcome completes it.)
 */
const CALLBACK_NON_CONNECT_OUTCOMES = new Set<CallOutcome>([
  "voicemail",
  "no_answer",
  "busy",
  "failed",
  "invalid_number",
  "hung_up_immediately",
]);

/**
 * Did this call's outcome represent a real human connection (or a live attempt
 * that consumes a scheduled callback)? A null/unknown outcome is treated as a
 * non-connect so the callback is conservatively left pending. Exported so
 * callers can reuse the exact same classification.
 */
export function callbackOutcomeConnected(
  outcome: CallOutcome | null | undefined,
): boolean {
  if (!outcome) return false;
  return !CALLBACK_NON_CONNECT_OUTCOMES.has(outcome);
}

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

/**
 * Mark a lead's DUE pending callbacks as completed once we've actually
 * CONNECTED to the lead on a dialed call. Without this, the callback row stays
 * `pending` forever after the call, so the lead keeps showing as an "overdue
 * callback" in the UI even though the callback was already made. Call this when
 * a call to the lead is placed/completed. Only callbacks whose scheduled time
 * has arrived are closed — a future callback is left untouched.
 *
 * #23: a due callback must ONLY be completed when the call actually reached a
 * human (or made a live attempt that consumes the callback). For a non-connect
 * outcome (voicemail / no_answer / busy / failed / invalid_number /
 * hung_up_immediately) the callback stays PENDING so the retry engine's
 * voicemail-escalation ladder (escalateCallbackVoicemail: +30min → next day →
 * 'missed') can run instead of the callback being wrongly marked 'completed'
 * and the lead dropping into the generic 2-day retry. Pass the call's outcome
 * so we can make that decision; `connected` may be passed directly when the
 * caller's path only runs after a confirmed connection.
 */
export async function resolveDueCallbacksForLead(
  supabase: SupabaseClient<Database>,
  leadId: string,
  options: { outcome?: CallOutcome | null; connected?: boolean },
): Promise<void> {
  const connected =
    options.connected ?? callbackOutcomeConnected(options.outcome);
  // Non-connect (voicemail / no-answer / …): leave the due callback PENDING so
  // the escalation ladder can run. Do nothing here.
  if (!connected) return;
  await supabase
    .from("callbacks")
    .update({ status: "completed" })
    .eq("lead_id", leadId)
    .eq("status", "pending")
    .lte("scheduled_at", new Date().toISOString());
}
