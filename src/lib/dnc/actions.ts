"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";

export type DncReason =
  | "dnc_requested"
  | "invalid_number"
  | "language_barrier"
  | "manual"
  | "imported";

export type DncResult = { error: string | null };

const DNC_PATH = "/dnc";

/** Add one phone number to the workspace DNC list. */
export async function addToDnc(input: {
  phone: string;
  reason: DncReason;
  company: string;
}): Promise<DncResult> {
  const phone = input.phone.trim();
  if (!phone) return { error: "Enter a phone number." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { error } = await supabase.from("dnc_entries").insert({
    phone,
    reason: input.reason,
    company_snapshot: input.company.trim() || null,
    added_by_user_id: user.id,
  });
  if (error) {
    return {
      error:
        error.code === "23505"
          ? "That number is already on the DNC list."
          : "Could not add the number.",
    };
  }

  revalidatePath(DNC_PATH);
  return { error: null };
}

/** Remove a number from the DNC list. Admin only; logs the removal. */
export async function removeFromDnc(input: {
  phone: string;
  reasonText: string;
}): Promise<DncResult> {
  const reasonText = input.reasonText.trim();
  if (!reasonText) {
    return { error: "Enter a reason for removing this number." };
  }

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
    return { error: "Only admins can remove numbers from DNC." };
  }

  // Log first so we never delete without a paper trail.
  const { error: logError } = await supabase.from("dnc_removals").insert({
    phone: input.phone,
    removed_by_user_id: user.id,
    reason_text: reasonText,
  });
  if (logError) return { error: "Could not log the removal." };

  const { error: deleteError } = await supabase
    .from("dnc_entries")
    .delete()
    .eq("phone", input.phone);
  if (deleteError) return { error: "Could not remove the number." };

  revalidatePath(DNC_PATH);
  return { error: null };
}

/**
 * Bulk-remove DNC entries by id. Admin only. Writes one row to
 * `dnc_removals` per phone (with the shared reason text) before deleting,
 * so the audit log captures every removal even when done in a batch.
 */
export async function bulkRemoveFromDnc(input: {
  ids: string[];
  reasonText: string;
}): Promise<DncResult & { removed?: number }> {
  const reasonText = input.reasonText.trim();
  if (!reasonText) {
    return { error: "Enter a reason for removing these numbers." };
  }
  if (input.ids.length === 0) {
    return { error: "No numbers selected." };
  }

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
    return { error: "Only admins can remove numbers from DNC." };
  }

  // Look up the phones being removed so the audit log captures them.
  const { data: entries } = await supabase
    .from("dnc_entries")
    .select("id, phone")
    .in("id", input.ids);
  if (!entries || entries.length === 0) {
    return { error: "Those numbers are not on the list." };
  }

  // Log every removal first — never delete without a paper trail.
  const logRows = entries.map((e) => ({
    phone: e.phone,
    removed_by_user_id: user.id,
    reason_text: reasonText,
  }));
  const { error: logError } = await supabase
    .from("dnc_removals")
    .insert(logRows);
  if (logError) return { error: "Could not log the removals." };

  const { error: deleteError } = await supabase
    .from("dnc_entries")
    .delete()
    .in(
      "id",
      entries.map((e) => e.id),
    );
  if (deleteError) return { error: "Could not remove the numbers." };

  revalidatePath(DNC_PATH);
  return { error: null, removed: entries.length };
}

/**
 * Bulk-add the selected leads' phone numbers to DNC. Used from the leads
 * bulk action bar. Skips leads without a phone and silently swallows the
 * unique-violation that happens when a number is already on the list.
 */
export async function bulkAddLeadsToDnc(input: {
  leadIds: string[];
}): Promise<DncResult & { added?: number }> {
  if (input.leadIds.length === 0) return { error: "No leads selected." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { data: leads } = await supabase
    .from("leads")
    .select("business_phone, company")
    .in("id", input.leadIds)
    .not("business_phone", "is", null);

  const rows = (leads ?? [])
    .filter(
      (l): l is { business_phone: string; company: string | null } =>
        typeof l.business_phone === "string" && l.business_phone.length > 0,
    )
    .map((l) => ({
      phone: l.business_phone,
      company_snapshot: l.company,
      reason: "manual" as const,
      added_by_user_id: user.id,
    }));
  if (rows.length === 0) {
    return { error: "None of the selected leads have a phone number." };
  }

  // Use upsert with ignoreDuplicates so already-DNC numbers don't fail
  // the whole batch.
  const { error, count } = await supabase.from("dnc_entries").upsert(rows, {
    onConflict: "phone",
    ignoreDuplicates: true,
    count: "exact",
  });
  if (error) return { error: "Could not add the selected leads to DNC." };

  revalidatePath(DNC_PATH);
  revalidatePath("/leads");
  return { error: null, added: count ?? 0 };
}
