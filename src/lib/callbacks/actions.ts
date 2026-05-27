"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";

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

  // The lead was in `callback` status pointing at this scheduled time.
  // Cancelling should hand the lead back to the standard queue.
  await supabase
    .from("leads")
    .update({ status: "ready_to_call", next_call_at: null })
    .eq("id", cb.lead_id);

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

  // Bump the lead's next_call_at so the dialer queue picks up the new time.
  await supabase
    .from("leads")
    .update({ next_call_at: newAt })
    .eq("id", cb.lead_id);

  await supabase.from("system_events").insert({
    kind: "callback_rescheduled",
    actor_user_id: user.id,
    ref_table: "callbacks",
    ref_id: input.callbackId,
    payload: { from: previousAt, to: newAt },
  });

  revalidatePath("/callbacks");
  return { error: null };
}
