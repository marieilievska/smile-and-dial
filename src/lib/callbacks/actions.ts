"use server";

import { revalidatePath } from "next/cache";

import {
  resyncLeadAfterCallbackRemoval,
  syncLeadNextCallToEarliestCallback,
} from "@/lib/callbacks/sync-next-call";
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
  // its last one, fall back to the lead's latest call DISPOSITION (e.g. a
  // gatekeeper call → the ~2-day retry) so its Next call reflects the
  // disposition instead of being blanked. Only when there's no disposition to
  // derive from is the lead handed back to the standard queue. If other pending
  // callbacks remain, the lead keeps pointing at the soonest.
  if (cb.lead_id) {
    await resyncLeadAfterCallbackRemoval(supabase, cb.lead_id);
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
 *  falls back to the lead's latest call DISPOSITION (e.g. gatekeeper → ~2-day
 *  retry), and only hands the lead back to the standard queue when there's no
 *  disposition to derive from. RLS scopes the update to the lead's owner or an
 *  admin. */
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
    await resyncLeadAfterCallbackRemoval(supabase, cb.lead_id);
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
 * that was still pending, the lead is re-pointed at its earliest remaining
 * callback, or — if none remain — its Next call falls back to its latest call
 * DISPOSITION (e.g. gatekeeper → the ~2-day retry), only handing the lead back
 * to the standard queue when there's no disposition to derive from. Either way
 * it's never left pointing at a callback time that no longer exists. Runs via
 * the service role (no delete RLS policy on callbacks) after confirming the
 * caller is an admin.
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
    .select("lead_id, status")
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

  // Re-sync each affected lead against its REMAINING pending callbacks. A lead
  // can have several pending callbacks; deleting one shouldn't blindly reset it
  // if a later one survives. The delete already ran, so
  // resyncLeadAfterCallbackRemoval now sees the true remaining state: it
  // re-points the lead at the soonest survivor, or — if none remain — falls back
  // to the lead's latest call disposition (only when still in 'callback'). Runs
  // sequentially to keep the service-role load modest; the selection is
  // operator-sized.
  for (const leadId of pendingLeadIds) {
    await resyncLeadAfterCallbackRemoval(admin, leadId);
  }

  revalidatePath("/callbacks");
  revalidatePath("/leads");
  return { error: null, deleted: clean.length };
}
