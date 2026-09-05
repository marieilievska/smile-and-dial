"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";

export type CustomFieldType = "text" | "number" | "date" | "boolean" | "select";

export type FieldActionResult = { error: string | null };

export type CustomFieldInput = {
  name: string;
  type: CustomFieldType;
  required: boolean;
  options: string[];
};

type Supabase = Awaited<ReturnType<typeof createClient>>;

/**
 * Ownership (20260905193000): everyone can see and use every field, but only
 * the person who created a field may edit or reorder it (an admin may also
 * manage one with no creator), and the creator or an admin may delete it.
 * RLS enforces that; a policy miss surfaces as zero rows, never as an error,
 * so every write below reads its row count back and turns zero into this.
 */
const NOT_CREATOR = "Only the person who created this field can change it.";

async function requireSignedIn(
  supabase: Supabase,
): Promise<{ ok: true } | { error: string }> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };
  return { ok: true };
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Create a custom field and return its id. Mirrors `createCustomField`
 *  but surfaces the new row's id so callers (e.g. the import wizard's
 *  inline-create affordance) can auto-map the column to the new field
 *  without a round-trip through Settings.
 *
 *  Open to any signed-in teammate (members included). `created_by`
 *  defaults to the caller in the database. Limits the type set to the four
 *  primitive types since picking options for a "select" field requires
 *  more UI than the inline dialog should carry. */
export async function createCustomFieldInline(input: {
  name: string;
  type: "text" | "number" | "date" | "boolean";
}): Promise<{ id: string | null; error: string | null }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { id: null, error: "You are not signed in." };

  const name = input.name.trim();
  if (!name) return { id: null, error: "Enter a field name." };
  const slug = slugify(name);
  if (!slug) {
    return { id: null, error: "Use a name with letters or numbers." };
  }

  // If a field with this slug already exists, reuse it instead of
  // colliding — the user probably just wants to map the column to the
  // existing field.
  const { data: existing } = await supabase
    .from("custom_field_defs")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();
  if (existing) {
    return { id: existing.id, error: null };
  }

  const { count } = await supabase
    .from("custom_field_defs")
    .select("id", { count: "exact", head: true });

  const { data, error } = await supabase
    .from("custom_field_defs")
    .insert({
      name,
      slug,
      type: input.type,
      required: false,
      options: [],
      sort_order: count ?? 0,
    })
    .select("id")
    .single();

  if (error || !data) {
    if (error && /duplicate|unique/i.test(error.message)) {
      return { id: null, error: "A field with that name already exists." };
    }
    return { id: null, error: "Could not create the field." };
  }

  revalidatePath("/settings/custom-fields");
  revalidatePath("/leads/import");
  return { id: data.id, error: null };
}

export async function createCustomField(
  input: CustomFieldInput,
): Promise<FieldActionResult> {
  const supabase = await createClient();
  const auth = await requireSignedIn(supabase);
  if ("error" in auth) return { error: auth.error };

  const name = input.name.trim();
  if (!name) return { error: "Enter a field name." };
  const slug = slugify(name);
  if (!slug) return { error: "Use a name with letters or numbers." };

  const { count } = await supabase
    .from("custom_field_defs")
    .select("id", { count: "exact", head: true });

  const { error } = await supabase.from("custom_field_defs").insert({
    name,
    slug,
    type: input.type,
    required: input.required,
    options: input.type === "select" ? input.options : [],
    sort_order: count ?? 0,
  });
  if (error) {
    if (/duplicate|unique/i.test(error.message)) {
      return { error: "A field with that name already exists." };
    }
    return { error: "Could not create the field." };
  }

  revalidatePath("/settings/custom-fields");
  return { error: null };
}

export async function updateCustomField(
  id: string,
  input: CustomFieldInput,
): Promise<FieldActionResult> {
  const supabase = await createClient();
  const auth = await requireSignedIn(supabase);
  if ("error" in auth) return { error: auth.error };

  const name = input.name.trim();
  if (!name) return { error: "Enter a field name." };

  const { data: updated, error } = await supabase
    .from("custom_field_defs")
    .update({
      name,
      type: input.type,
      required: input.required,
      options: input.type === "select" ? input.options : [],
    })
    .eq("id", id)
    .select("id");
  if (error) return { error: "Could not update the field." };
  if (!updated || updated.length === 0) return { error: NOT_CREATOR };

  revalidatePath("/settings/custom-fields");
  return { error: null };
}

/** Delete a field. The creator or an admin (RLS); zero rows means neither. */
export async function deleteCustomField(
  id: string,
): Promise<FieldActionResult> {
  const supabase = await createClient();
  const auth = await requireSignedIn(supabase);
  if ("error" in auth) return { error: auth.error };

  const { data: deleted, error } = await supabase
    .from("custom_field_defs")
    .delete()
    .eq("id", id)
    .select("id");
  if (error) return { error: "Could not delete the field." };
  if (!deleted || deleted.length === 0) return { error: NOT_CREATOR };

  revalidatePath("/settings/custom-fields");
  return { error: null };
}

/** Swap a field with its neighbour. Done in the database
 *  (`move_custom_field`, 20260905193000) because the swap touches two rows
 *  and the neighbour is usually someone else's field: two plain updates
 *  under the creator-only policy would half-apply. The function checks the
 *  caller may move the field they picked and swaps regardless of who owns
 *  the neighbour -- position in the shared list is not part of a field. */
export async function moveCustomField(
  id: string,
  direction: "up" | "down",
): Promise<FieldActionResult> {
  const supabase = await createClient();
  const auth = await requireSignedIn(supabase);
  if ("error" in auth) return { error: auth.error };

  const { data: outcome, error } = await supabase.rpc("move_custom_field", {
    in_id: id,
    in_direction: direction,
  });
  if (error) return { error: "Could not reorder the fields." };
  if (outcome === "not_owner" || outcome === "not_found") {
    return { error: NOT_CREATOR };
  }

  revalidatePath("/settings/custom-fields");
  return { error: null };
}
