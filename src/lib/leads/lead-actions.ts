"use server";

import { revalidatePath } from "next/cache";

import type { Database, Json } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";

import { IMPORTABLE_FIELDS } from "./import-fields";

type LeadUpdate = Database["public"]["Tables"]["leads"]["Update"];

/** Standard lead fields the detail modal is allowed to edit. */
const EDITABLE_KEYS = new Set<string>(IMPORTABLE_FIELDS.map((f) => f.key));
const NUMERIC_KEYS = new Set(["google_rating", "google_reviews"]);

/** Update a single standard field on a lead. RLS enforces ownership. */
export async function updateLeadField(input: {
  leadId: string;
  field: string;
  value: string;
}): Promise<{ error: string | null }> {
  if (!EDITABLE_KEYS.has(input.field)) {
    return { error: "That field cannot be edited." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const trimmed = input.value.trim();
  let value: string | number | null = trimmed === "" ? null : trimmed;
  if (NUMERIC_KEYS.has(input.field) && value !== null) {
    const parsed = Number(value);
    if (Number.isNaN(parsed)) return { error: "Enter a valid number." };
    value = parsed;
  }

  const { error } = await supabase
    .from("leads")
    .update({ [input.field]: value } as LeadUpdate)
    .eq("id", input.leadId);
  if (error) return { error: "Could not save that change." };

  revalidatePath("/leads");
  return { error: null };
}

/** Manually set the lead's "decision maker reached" flag. The post-call
 *  webhook maintains this automatically, but operators can correct it when the
 *  AI's read was wrong (e.g. a receptionist declined and it was logged as a DM
 *  contact). RLS enforces ownership. */
export async function setLeadDecisionMakerReached(input: {
  leadId: string;
  value: boolean;
}): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { error } = await supabase
    .from("leads")
    .update({ decision_maker_reached: input.value })
    .eq("id", input.leadId);
  if (error) return { error: "Could not save that change." };

  revalidatePath("/leads");
  return { error: null };
}

/**
 * Set (or clear) a custom field value on a lead. An empty value removes the
 * row so a blank custom field never lingers in the database.
 */
export async function updateLeadCustomValue(input: {
  leadId: string;
  customFieldId: string;
  value: string | boolean;
}): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  if (input.value === "" || input.value === false) {
    const { error } = await supabase
      .from("lead_custom_values")
      .delete()
      .eq("lead_id", input.leadId)
      .eq("custom_field_id", input.customFieldId);
    if (error) return { error: "Could not save that change." };
  } else {
    const { error } = await supabase.from("lead_custom_values").upsert({
      lead_id: input.leadId,
      custom_field_id: input.customFieldId,
      value: input.value,
    });
    if (error) return { error: "Could not save that change." };
  }

  revalidatePath("/leads");
  return { error: null };
}

export type MergeCandidate = {
  id: string;
  company: string | null;
  business_phone: string | null;
};

/**
 * Search the current user's leads (admins see all) by phone / company /
 * email, excluding the source inbound lead itself and any other inbound
 * auto-created leads. Used by the merge dialog's destination picker.
 */
export async function searchMergeCandidates(input: {
  sourceLeadId: string;
  query: string;
}): Promise<{ candidates: MergeCandidate[]; error: string | null }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { candidates: [], error: "You are not signed in." };

  const safe = input.query.replace(/[%,()\\*]/g, "").trim();
  if (!safe) return { candidates: [], error: null };

  const { data } = await supabase
    .from("leads")
    .select("id, company, business_phone, list:lists(is_inbound_default)")
    .neq("id", input.sourceLeadId)
    .is("deleted_at", null)
    .or(
      `company.ilike.%${safe}%,business_phone.ilike.%${safe}%,business_email.ilike.%${safe}%`,
    )
    .limit(20);

  // Drop any matches that happen to live in someone else's inbound list.
  const candidates = (data ?? [])
    .filter((l) => !l.list?.is_inbound_default)
    .slice(0, 10)
    .map((l) => ({
      id: l.id,
      company: l.company,
      business_phone: l.business_phone,
    }));
  return { candidates, error: null };
}

/** Fields the merge action copies from the inbound source onto an existing
 *  destination lead — but only when the destination's value is null/empty.
 *  Manual edits on the destination always win. */
const MERGEABLE_FIELDS = [
  "company",
  "business_email",
  "owner_name",
  "owner_phone",
  "manager_name",
  "employee_name",
  "website",
  "category",
  "city",
  "state",
  "google_place_id",
  "ai_summary",
];

/**
 * Merge an auto-created inbound lead into an existing destination lead.
 * Per BUILD_PLAN §6 line 559. The source must be in the owner's
 * is_inbound_default list (the system-managed "Inbound" list); the
 * destination must belong to the same owner.
 *
 * Side effects:
 *   - Non-null fields from source fill empty fields on destination
 *   - All `calls` rows for source are repointed to destination
 *   - All `callbacks` for source are repointed to destination
 *   - Source lead is soft-deleted (deleted_at = now)
 *   - Audit log: system_events kind='lead_merged' with {from, to}
 */
export async function mergeInboundLead(input: {
  sourceLeadId: string;
  destinationLeadId: string;
}): Promise<{ error: string | null }> {
  if (input.sourceLeadId === input.destinationLeadId) {
    return { error: "Pick a different destination lead." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  // Both leads must exist; the source must be in the inbound list; both
  // must belong to the same owner (RLS will also enforce this).
  const { data: source } = await supabase
    .from("leads")
    .select("*, list:lists(is_inbound_default)")
    .eq("id", input.sourceLeadId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!source) return { error: "Source lead not found." };
  if (!source.list?.is_inbound_default) {
    return { error: "Only auto-created inbound leads can be merged." };
  }

  const { data: dest } = await supabase
    .from("leads")
    .select("*")
    .eq("id", input.destinationLeadId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!dest) return { error: "Destination lead not found." };
  if (dest.owner_id !== source.owner_id) {
    return { error: "Destination lead has a different owner." };
  }

  // Compose the patch — only write fields where the destination is empty.
  const srcRow = source as Record<string, unknown>;
  const destRow = dest as Record<string, unknown>;
  const patch: LeadUpdate = {};
  for (const key of MERGEABLE_FIELDS) {
    const srcValue = srcRow[key];
    const destValue = destRow[key];
    if (
      srcValue != null &&
      srcValue !== "" &&
      (destValue == null || destValue === "")
    ) {
      (patch as Record<string, unknown>)[key] = srcValue;
    }
  }
  // Apply the whole merge atomically in one Postgres transaction
  // (merge_inbound_lead): patch the destination's empty fields, repoint
  // calls + callbacks, soft-delete the source, write the audit row. Either
  // all of it commits or none of it does — a mid-sequence failure can no
  // longer leave call/callback ownership half-moved with the source still
  // live. The function re-verifies ownership + inbound-default server-side.
  const { error: mergeError } = await supabase.rpc("merge_inbound_lead", {
    in_source_lead_id: input.sourceLeadId,
    in_destination_lead_id: input.destinationLeadId,
    in_patch: patch as Json,
    in_actor: user.id,
  });
  if (mergeError) {
    return { error: "Could not merge the lead. Nothing was changed." };
  }

  revalidatePath("/leads");
  return { error: null };
}
