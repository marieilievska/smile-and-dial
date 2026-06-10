import "server-only";

import { createClient } from "@supabase/supabase-js";

import { applyRetryForCall } from "@/lib/dialer/retry-engine";
import type { Database } from "@/lib/supabase/database.types";

type SupabaseAdmin = ReturnType<typeof createClient<Database>>;

/** In-flight statuses — a call sitting in one of these is "active" and counts
 *  against the owner's concurrency cap and shows the lead as "on call". */
const ACTIVE_STATUSES = ["queued", "dialing", "ringing", "in_progress"];

/** Max minutes a call can legitimately stay in flight. The agent's hard call
 *  ceiling is 700s (~12 min), so anything older than this is dead. */
const STALE_MINUTES = 15;

/** Human browser calls are normally terminalized by their Twilio Dial-completion
 *  callback, so they're EXEMPT from the 15-min AI reaper (a real human call can
 *  legitimately run long). But if that callback never arrives, the row would sit
 *  'dialing' forever and permanently hold an owner concurrency slot. This far
 *  longer ceiling is a backstop that frees the slot without ever cutting off a
 *  genuine conversation. */
const HUMAN_STALE_MINUTES = 60;

/**
 * Close calls stuck in an in-flight status past the max call window.
 *
 * ElevenLabs now owns the call end-to-end, so its post-call webhook is our
 * ONLY terminal signal. If that webhook never arrives (a dropped delivery, a
 * call that never connected and emitted nothing), the row would otherwise sit
 * "dialing" forever — counting against the owner's concurrency cap (blocking
 * every future dial) and showing the lead as perpetually "on call". This reaps
 * those rows to a terminal `failed`. A late webhook still recovers the truth:
 * the post-call handler updates the row unconditionally, overwriting this.
 *
 * Idempotent and cheap; safe to call before every dial and on each dialer tick.
 */
export async function closeStaleActiveCalls(
  supabase: SupabaseAdmin,
): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_MINUTES * 60 * 1000).toISOString();
  const { data: reaped } = await supabase
    .from("calls")
    .update({
      status: "failed",
      outcome: "failed",
      ended_at: new Date().toISOString(),
    })
    .in("status", ACTIVE_STATUSES)
    .lt("created_at", cutoff)
    .is("ended_at", null)
    // Only autopilot (AI) calls. Human browser calls are terminalized by their
    // Dial-completion callback (and dispositioned by the human), so a long live
    // human call must never be killed mid-call by this reaper.
    .eq("call_mode", "ai")
    // Never overwrite a call that already has an outcome — this protects manual
    // dispositions and any already-classified call from being clobbered to
    // failed/failed.
    .is("outcome", null)
    .select("id");

  // FIX A (#8 / #6): a reaped call set the lead nowhere — it still held the
  // 2-minute claim lease (or a 30-min placeholder), so the lead would be
  // re-dialed almost immediately and never reach the 2-day cool-off. Run the
  // retry engine for each reaped call so the lead gets the proper 'failed'
  // backoff. Idempotent via the engine's CAS on retry_applied_at. (A later
  // task will make this reaper skip human calls; for now we reschedule
  // whatever it reaps.)
  for (const call of reaped ?? []) {
    await applyRetryForCall(call.id);
  }

  // Backstop for human browser calls whose Dial-completion callback never
  // arrived (dropped webhook): terminalize anything still in-flight past the
  // far-longer human ceiling so it stops holding an owner concurrency slot.
  // We do NOT run the retry engine here — human calls are operator-driven, not
  // autopilot-scheduled — and we leave `outcome` null (the call was never
  // dispositioned; only the disposition or a real completion sets an outcome).
  const humanCutoff = new Date(
    Date.now() - HUMAN_STALE_MINUTES * 60 * 1000,
  ).toISOString();
  await supabase
    .from("calls")
    .update({ status: "failed", ended_at: new Date().toISOString() })
    .eq("call_mode", "human")
    .in("status", ACTIVE_STATUSES)
    .lt("created_at", humanCutoff)
    .is("ended_at", null)
    .is("outcome", null);
}
