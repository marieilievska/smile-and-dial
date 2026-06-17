"use server";

import { revalidatePath } from "next/cache";

import { syncLeadNextCallToEarliestCallback } from "@/lib/callbacks/sync-next-call";
import { createClient } from "@/lib/supabase/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";

export type ActionResult = { error: string | null };

/** Cancel a pending callback. Soft-cancel via status; the row stays for
 *  audit. RLS scopes it to the lead's owner or an admin. */
export async function cancelCallback(
  callbackId: string,
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { data: cb } = await supabase
    .from("callbacks")
    .select("id, lead_id, status")
    .eq("id", callbackId)
    .maybeSingle();
  if (!cb) return { error: "Callback not found." };
  if (cb.status !== "pending") {
    return { error: "Only pending callbacks can be cancelled." };
  }

  const { error } = await supabase
    .from("callbacks")
    .update({ status: "cancelled" })
    .eq("id", callbackId);
  if (error) return { error: "Could not cancel the callback." };

  // Re-point the lead at its earliest REMAINING pending callback. If this was
  // its last one, the sync hands the lead back to the standard queue
  // (ready_to_call, next_call_at cleared) instead of stranding it in 'callback'
  // pointing at a cancelled row. If other pending callbacks remain, the lead
  // keeps pointing at the soonest. (This replaces the old blanket
  // ready_to_call reset, which wrongly dropped a lead that still had a later
  // pending callback.)
  if (cb.lead_id) {
    await syncLeadNextCallToEarliestCallback(supabase, cb.lead_id);
  }

  await supabase.from("system_events").insert({
    kind: "callback_cancelled",
    actor_user_id: user.id,
    ref_table: "callbacks",
    ref_id: callbackId,
    payload: { lead_id: cb.lead_id },
  });

  revalidatePath("/callbacks");
  revalidatePath("/leads");
  return { error: null };
}

/** Manually mark a pending callback as completed — the operator handled the
 *  redial (or it's otherwise resolved) and it should no longer sit in the
 *  pending queue. Like cancel, this re-syncs the lead: it re-points the lead at
 *  its earliest REMAINING pending callback, or — if this was the last one —
 *  hands the lead back to the standard queue rather than stranding it in
 *  'callback'. RLS scopes the update to the lead's owner or an admin. */
export async function completeCallback(
  callbackId: string,
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { data: cb } = await supabase
    .from("callbacks")
    .select("id, lead_id, status")
    .eq("id", callbackId)
    .maybeSingle();
  if (!cb) return { error: "Callback not found." };
  if (cb.status !== "pending") {
    return { error: "Only pending callbacks can be marked completed." };
  }

  const { error } = await supabase
    .from("callbacks")
    .update({ status: "completed" })
    .eq("id", callbackId);
  if (error) return { error: "Could not mark the callback completed." };

  if (cb.lead_id) {
    await syncLeadNextCallToEarliestCallback(supabase, cb.lead_id);
  }

  await supabase.from("system_events").insert({
    kind: "callback_completed",
    actor_user_id: user.id,
    ref_table: "callbacks",
    ref_id: callbackId,
    payload: { lead_id: cb.lead_id },
  });

  revalidatePath("/callbacks");
  revalidatePath("/leads");
  return { error: null };
}

/** Reschedule a pending callback to a new time. */
export async function rescheduleCallback(input: {
  callbackId: string;
  scheduledAt: string;
}): Promise<ActionResult> {
  const when = new Date(input.scheduledAt);
  if (Number.isNaN(when.getTime())) {
    return { error: "Pick a valid date and time." };
  }
  if (when.getTime() <= Date.now()) {
    return { error: "Pick a time in the future." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { data: cb } = await supabase
    .from("callbacks")
    .select("id, lead_id, status, scheduled_at")
    .eq("id", input.callbackId)
    .maybeSingle();
  if (!cb) return { error: "Callback not found." };
  if (cb.status !== "pending") {
    return { error: "Only pending callbacks can be rescheduled." };
  }

  const previousAt = cb.scheduled_at;
  const newAt = when.toISOString();
  const { error } = await supabase
    .from("callbacks")
    .update({ scheduled_at: newAt, voicemail_attempts: 0 })
    .eq("id", input.callbackId);
  if (error) return { error: "Could not reschedule." };

  // Re-sync the lead's next_call_at to its EARLIEST pending callback. The new
  // time isn't necessarily the soonest (the lead may have another, earlier
  // pending callback), so recompute rather than blindly bumping to newAt — that
  // keeps the dialer pointed at the right one.
  if (cb.lead_id) {
    await syncLeadNextCallToEarliestCallback(supabase, cb.lead_id);
  }

  await supabase.from("system_events").insert({
    kind: "callback_rescheduled",
    actor_user_id: user.id,
    ref_table: "callbacks",
    ref_id: input.callbackId,
    payload: { from: previousAt, to: newAt },
  });

  revalidatePath("/callbacks");
  revalidatePath("/leads");
  return { error: null };
}

export type DeleteCallbacksResult = {
  error: string | null;
  deleted?: number;
};

/**
 * Permanently delete callbacks (admin only). Callbacks are normally cancelled
 * (status='cancelled') to preserve the audit trail; this is a deliberate
 * escape hatch for clearing test/junk rows. Hard delete. For any deleted row
 * that was still pending, the lead is handed back to the standard queue
 * (status ready_to_call, next_call_at cleared) so it isn't left pointing at a
 * callback time that no longer exists. Runs via the service role (no delete
 * RLS policy on callbacks) after confirming the caller is an admin.
 */
export async function deleteCallbacks(
  ids: string[],
): Promise<DeleteCallbacksResult> {
  const clean = [...new Set(ids.filter((id) => typeof id === "string" && id))];
  if (clean.length === 0) return { error: "No callbacks selected." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };
  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (me?.role !== "admin") {
    return { error: "Only an admin can delete callbacks." };
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) return { error: "Server is missing Supabase credentials." };
  const admin = createAdminClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Leads whose pending callback we're deleting get handed back to the queue
  // so they don't keep a stale `callback` schedule pointing at nothing.
  const { data: rows } = await admin
    .from("callbacks")
    .select("id, lead_id, status")
    .in("id", clean);
  const pendingLeadIds = [
    ...new Set(
      (rows ?? [])
        .filter((r) => r.status === "pending" && r.lead_id)
        .map((r) => r.lead_id as string),
    ),
  ];

  const { error } = await admin.from("callbacks").delete().in("id", clean);
  if (error) return { error: "Could not delete the selected callbacks." };

  // Audit trail. A hard delete leaves NO row behind, so — unlike cancel /
  // complete / reschedule, which each log an event — a deletion (and the reason
  // a lead's next_call_at suddenly cleared) would otherwise vanish without a
  // trace. Record one `callback_deleted` event per removed row so the history
  // stays reconstructable. Best-effort: a logging hiccup must not fail the
  // delete the operator already confirmed.
  const deletedRows = rows ?? [];
  if (deletedRows.length > 0) {
    await supabase.from("system_events").insert(
      deletedRows.map((r) => ({
        kind: "callback_deleted",
        actor_user_id: user.id,
        ref_table: "callbacks",
        ref_id: r.id,
        payload: { lead_id: r.lead_id, status: r.status, hard_delete: true },
      })),
    );
  }

  // Re-sync each affected lead against its REMAINING pending callbacks. A lead
  // can have several pending callbacks; deleting one shouldn't blindly reset it
  // to ready_to_call if a later one survives. The delete already ran, so
  // syncLeadNextCallToEarliestCallback now sees the true remaining state: it
  // re-points the lead at the soonest survivor, or — if none remain — hands it
  // back to the queue (only when still in 'callback'). Runs sequentially to keep
  // the service-role load modest; the selection is operator-sized.
  for (const leadId of pendingLeadIds) {
    await syncLeadNextCallToEarliestCallback(admin, leadId);
  }

  revalidatePath("/callbacks");
  revalidatePath("/leads");
  return { error: null, deleted: clean.length };
}
