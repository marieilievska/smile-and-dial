"use server";

import { revalidatePath } from "next/cache";

import type { Database } from "@/lib/supabase/database.types";
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
