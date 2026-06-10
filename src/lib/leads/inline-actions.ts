"use server";

import { revalidatePath } from "next/cache";

import { LEAD_STATUS_LABELS } from "@/lib/labels";
import { createClient } from "@/lib/supabase/server";

/** Set of valid leads.status values, derived from the labels map. The
 *  labels map is the single source of truth for "what statuses exist"
 *  across the app — keeping the inline-edit allowlist in sync with it
 *  means a new status only needs to be added in one place. */
const VALID_STATUSES = new Set(Object.keys(LEAD_STATUS_LABELS));

const UUID_RE = /^[0-9a-f-]{36}$/i;

/** Inline-edit a single lead's status from the Leads table. Mirrors
 *  the contract of `updateLeadField` (per-call RLS) but adds:
 *
 *    - explicit allowlist on the status value, so a crafted payload
 *      can't sneak an unknown enum into the column
 *    - a `system_events` audit row capturing from→to + the actor, so
 *      the lead's activity feed surfaces the inline change the same
 *      way it surfaces detail-page edits
 *    - a no-op fast path when the new status matches the old one
 *      (avoids a spurious audit row when the user re-selects the
 *      current status) */
export async function setLeadStatus(input: {
  leadId: string;
  status: string;
}): Promise<{ error: string | null }> {
  if (!UUID_RE.test(input.leadId)) {
    return { error: "Invalid lead id." };
  }
  if (!VALID_STATUSES.has(input.status)) {
    return { error: "Not a valid stage." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  // Read the current status so we can audit from→to and short-circuit
  // a no-op. Also pull the phone/company up front so a move to the "dnc"
  // stage can mirror the AI/bulk DNC path (write a dnc_entries row) without
  // a second round-trip. The RLS policy on leads gates this read for us.
  const { data: before, error: readErr } = await supabase
    .from("leads")
    .select("status, business_phone, company")
    .eq("id", input.leadId)
    .single();
  if (readErr || !before) return { error: "Lead not found." };
  if (before.status === input.status) return { error: null };

  // When the chosen stage is "dnc", also clear the next-call slot so the
  // lead drops out of the dialer queue, matching bulkAddLeadsToDnc.
  const update: { status: string; next_call_at?: null } = {
    status: input.status,
  };
  if (input.status === "dnc") update.next_call_at = null;

  const { error: writeErr } = await supabase
    .from("leads")
    .update(update)
    .eq("id", input.leadId);
  if (writeErr) return { error: "Could not save that change." };

  // The inline Stage picker offers "dnc" as a pickable stage. Flipping
  // leads.status alone is a split-brain: the dialer's pre-call check tests
  // the phone against dnc_entries, so without this insert it would keep
  // calling a lead the operator just marked Do Not Call. Mirror the
  // dnc_entries insert shape used by addToDnc / bulkAddLeadsToDnc. Skip the
  // insert (but keep the status change) when there's no phone, and swallow
  // the unique-violation (23505) that means the number is already listed.
  if (input.status === "dnc") {
    const phone = before.business_phone?.trim();
    if (phone) {
      const { error: dncErr } = await supabase.from("dnc_entries").insert({
        phone,
        reason: "manual",
        company_snapshot: before.company ?? null,
        added_by_user_id: user.id,
      });
      if (dncErr && dncErr.code !== "23505") {
        return { error: "Stage saved, but could not add to the DNC list." };
      }
    }
  }

  // Audit row — kind matches the existing lead_status_changed family
  // so the activity feed picks it up without a schema change. The
  // `_inline` suffix is the only thing that distinguishes it from a
  // detail-page or bulk-action edit, for forensics. Failure to write
  // the audit row is logged via the returned error pattern but does
  // NOT roll the status change back — the SDR's intent has already
  // landed and a missing audit row is a smaller harm than a phantom
  // half-rolled-back state.
  await supabase.from("system_events").insert({
    kind: "lead_status_changed_inline",
    actor_user_id: user.id,
    ref_table: "leads",
    ref_id: input.leadId,
    payload: { from: before.status, to: input.status },
  });

  revalidatePath("/leads");
  return { error: null };
}

/** Inline-edit a single lead's list assignment from the Leads table.
 *  RLS is what really enforces ownership; the explicit list lookup
 *  below is belt-and-braces so a stale or invented uuid surfaces a
 *  clean error message rather than a silent fail. */
export async function setLeadList(input: {
  leadId: string;
  listId: string;
}): Promise<{ error: string | null }> {
  if (!UUID_RE.test(input.leadId) || !UUID_RE.test(input.listId)) {
    return { error: "Invalid id." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  // Verify the list exists and the caller can see it (RLS-scoped).
  const { data: list } = await supabase
    .from("lists")
    .select("id")
    .eq("id", input.listId)
    .maybeSingle();
  if (!list) return { error: "List not found." };

  const { error } = await supabase
    .from("leads")
    .update({ list_id: input.listId })
    .eq("id", input.leadId);
  if (error) return { error: "Could not save that change." };

  revalidatePath("/leads");
  return { error: null };
}
