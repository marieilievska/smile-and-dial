"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";

/**
 * Move a registration to a different session.
 *
 * `dial_day` is deliberately NOT touched: the credit stays with the day whose
 * spend produced the booking, no matter how many times the session moves. The
 * person returns to the upcoming stage on the new date and can still be marked
 * attended, so a reschedule never reads as a no-show.
 */
export async function rescheduleRegistration(input: {
  leadId: string;
  newSessionIso: string;
}): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const when = new Date(input.newSessionIso);
  if (Number.isNaN(when.getTime())) return { error: "Pick a valid session." };

  // The registration being moved is the lead's latest active one — the seat
  // they currently hold. A cancelled booking is not a seat.
  const { data: regs } = await supabase
    .from("calendly_events")
    .select("id, scheduled_at")
    .eq("lead_id", input.leadId)
    .neq("status", "canceled")
    .order("scheduled_at", { ascending: false })
    .limit(1);
  const reg = regs?.[0];
  if (!reg) {
    return { error: "This lead has no active registration to move." };
  }

  const { error } = await supabase
    .from("calendly_events")
    .update({
      scheduled_at: when.toISOString(),
      rescheduled_at: new Date().toISOString(),
    })
    .eq("id", reg.id);
  if (error) return { error: "Could not move the registration." };

  const { error: leadError } = await supabase
    .from("leads")
    .update({ status: "rescheduled" })
    .eq("id", input.leadId);
  if (leadError) return { error: "Could not update the lead." };

  await supabase.from("system_events").insert({
    kind: "registration_rescheduled",
    actor_user_id: user.id,
    ref_table: "calendly_events",
    ref_id: reg.id,
    payload: { from: reg.scheduled_at, to: when.toISOString() },
  });

  revalidatePath("/goals");
  return { error: null };
}
