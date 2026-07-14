"use server";

import { revalidatePath } from "next/cache";

import { ID_CHUNK, chunk } from "@/lib/leads/chunk";
import { toE164UsCa } from "@/lib/leads/twilio-lookup";
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
  const raw = input.phone.trim();
  if (!raw) return { error: "Enter a phone number." };
  // Store in E.164 (+1XXXXXXXXXX) so the entry actually matches lead numbers
  // (which are always E.164) at dial time. The add dialog normalizes
  // client-side, but this is the server-side backstop for any other caller.
  const phone = toE164UsCa(raw);
  if (!phone) return { error: "Enter a valid US/CA phone number." };

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
 * bulk action bar and the lead-detail "Mark DNC" button. Skips leads
 * without a phone and silently swallows the unique-violation that happens
 * when a number is already on the list.
 *
 * The lead-id lookup is chunked (`ID_CHUNK` ids per request): a "select all
 * matching" sweep can carry thousands of ids, and a single `.in("id", …)`
 * filter overflows the request URL and fails the whole query — which the old
 * code swallowed into the misleading "None of the selected leads have a phone
 * number." message. Real errors are now surfaced.
 *
 * To match the AI tool path (which writes `dnc_entries` AND moves the lead out
 * of the calling pipeline), this also flips the matched leads to
 * `status = 'dnc'` and clears `next_call_at`, so a DNC'd lead leaves the
 * Ready-to-call count and the dialer queue instead of lingering half-handled.
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

  // Look up the leads in chunks so a large selection's id list never
  // overflows the request URL. Aggregate the rows across chunks and surface
  // any real error instead of swallowing it.
  type LeadRow = { business_phone: string | null; company: string | null };
  const leads: LeadRow[] = [];
  for (const ids of chunk(input.leadIds, ID_CHUNK)) {
    const { data, error } = await supabase
      .from("leads")
      .select("business_phone, company")
      .in("id", ids)
      .not("business_phone", "is", null);
    if (error) return { error: "Could not look up the selected leads." };
    leads.push(...((data ?? []) as LeadRow[]));
  }

  const rows = leads
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

  // Move the leads out of the calling pipeline so the Ready-to-call count
  // and dialer queue drop them — mirroring the AI tool path. Chunked for the
  // same URL-length reason as the lookup above. A failure here is non-fatal:
  // the numbers are already on the DNC list (so the dialer's pre-call check
  // will block them regardless); we surface it but don't claim success.
  for (const ids of chunk(input.leadIds, ID_CHUNK)) {
    const { error: statusError } = await supabase
      .from("leads")
      .update({ status: "dnc", next_call_at: null })
      .in("id", ids);
    if (statusError) {
      return { error: "Added to DNC, but could not update lead stages." };
    }
  }

  revalidatePath(DNC_PATH);
  revalidatePath("/leads");
  return { error: null, added: count ?? 0 };
}
