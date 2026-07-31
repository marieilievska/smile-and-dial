import "server-only";

import { createClient } from "@supabase/supabase-js";

import { syncLeadNextCallToEarliestCallback } from "@/lib/callbacks/sync-next-call";
import { anyCallReachedDm } from "@/lib/calls/decision-maker";
import { CONVERSATION_OUTCOMES } from "@/lib/calls/outcomes";
import { reapplyRetryForCall } from "@/lib/dialer/retry-engine";
import type { Database } from "@/lib/supabase/database.types";

type Admin = ReturnType<typeof createClient<Database>>;
type LeadUpdate = Database["public"]["Tables"]["leads"]["Update"];

const TERMINAL_WON = new Set(["goal_met", "transferred_to_human"]);
const DNC_OUTCOMES = new Set(["dnc", "invalid_number", "language_barrier"]);

/**
 * Recompute one lead's call-derived fields from its REMAINING calls, after some
 * of its calls were deleted. No calls remain → fresh reset. Calls remain →
 * rewind to reflect them, never un-winning a booked lead or un-blocking a DNC'd
 * one, and — for a lead heading back into normal rotation — re-derive its
 * next-call date from the MOST RECENT remaining call's outcome (so deleting one
 * call doesn't blank the schedule its other calls set up and make the lead
 * due-now). We don't replay the whole engine; we just re-run the retry on the
 * latest remaining dispositioned call, the same way a removed callback does.
 */
export async function recomputeLeadCallState(
  admin: Admin,
  leadId: string,
): Promise<void> {
  const { data: calls } = await admin
    .from("calls")
    .select("id, created_at, ended_at, outcome, summary, extracted_data")
    .eq("lead_id", leadId);
  const remaining = calls ?? [];

  // Per-campaign rolling summaries rebuild from subsequent calls; clear them on
  // reset so stale campaign memory doesn't survive a wipe.
  await admin.from("lead_campaign_summaries").delete().eq("lead_id", leadId);

  const base: LeadUpdate = {
    retry_counter: 0,
    retry_position: 0,
    call_back_later_count: 0,
    resting_until: null,
    next_call_at: null,
    updated_at: new Date().toISOString(),
  };

  if (remaining.length === 0) {
    await admin
      .from("leads")
      .update({
        ...base,
        status: "ready_to_call",
        last_call_at: null,
        call_attempts: 0,
        conversations: 0,
        // decision_maker_reached is sticky — never auto-cleared. Once we've
        // reached a decision maker it stays Yes (only the manual toggle clears
        // it), so it's intentionally omitted from this reset.
      })
      .eq("id", leadId);
  } else {
    // Most recent remaining call (by ended_at, else created_at) — drives
    // last_call_at.
    const latest = [...remaining]
      .sort((a, b) => {
        const ta = a.ended_at ?? a.created_at ?? "";
        const tb = b.ended_at ?? b.created_at ?? "";
        return ta < tb ? -1 : ta > tb ? 1 : 0;
      })
      .at(-1);
    const lastCallAt = latest ? (latest.ended_at ?? latest.created_at) : null;
    const conversations = remaining.filter(
      (c) => c.outcome && CONVERSATION_OUTCOMES.has(c.outcome),
    ).length;
    const dmReached = anyCallReachedDm(remaining);

    let status = "ready_to_call";
    if (remaining.some((c) => c.outcome && TERMINAL_WON.has(c.outcome))) {
      status = "goal_met";
    } else if (
      remaining.some((c) => c.outcome && DNC_OUTCOMES.has(c.outcome))
    ) {
      status = "dnc";
    } else {
      const { data: lead } = await admin
        .from("leads")
        .select("business_phone")
        .eq("id", leadId)
        .maybeSingle();
      if (lead?.business_phone) {
        const { data: dnc } = await admin
          .from("dnc_entries")
          .select("phone")
          .eq("phone", lead.business_phone)
          .maybeSingle();
        if (dnc) status = "dnc";
      }
    }

    const leadUpdate: LeadUpdate = {
      ...base,
      status,
      last_call_at: lastCallAt,
      call_attempts: remaining.length,
      conversations,
    };
    // decision_maker_reached is sticky — only ever set it TRUE, never un-mark a
    // lead we already reached just because the remaining calls didn't.
    if (dmReached) leadUpdate.decision_maker_reached = true;
    await admin.from("leads").update(leadUpdate).eq("id", leadId);

    // Re-derive the next-call date from the calls that REMAIN, instead of
    // leaving it blank (which made the lead due-now — the "deleting a call wipes
    // the schedule" surprise). Only for a lead going back into normal rotation:
    // goal_met / dnc are terminal and stay unscheduled, and a lead with a live
    // callback is repointed by the pendingCb block below. Run the retry engine
    // on the most recent remaining DISPOSITIONED call — the same mechanism
    // resyncLeadAfterCallbackRemoval uses. If that call's outcome schedules
    // nothing (e.g. it too was owned elsewhere), the lead simply keeps the blank
    // next_call_at set above.
    if (status === "ready_to_call") {
      const latestDispositioned = [...remaining]
        .filter((c) => c.outcome)
        .sort((a, b) => {
          const ta = a.ended_at ?? a.created_at ?? "";
          const tb = b.ended_at ?? b.created_at ?? "";
          return ta < tb ? -1 : ta > tb ? 1 : 0;
        })
        .at(-1);
      if (latestDispositioned?.id) {
        await reapplyRetryForCall(latestDispositioned.id);
      }
    }
  }

  // A callback from a call we did NOT delete keeps the lead in 'callback' and
  // pointed at its earliest pending callback.
  const { data: pendingCb } = await admin
    .from("callbacks")
    .select("id")
    .eq("lead_id", leadId)
    .eq("status", "pending")
    .limit(1)
    .maybeSingle();
  if (pendingCb) {
    await admin.from("leads").update({ status: "callback" }).eq("id", leadId);
    await syncLeadNextCallToEarliestCallback(admin, leadId);
  }
}
