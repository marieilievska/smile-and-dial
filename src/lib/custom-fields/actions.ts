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

async function requireAdmin(
  supabase: Supabase,
): Promise<{ ok: true } | { error: string }> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (me?.role !== "admin") return { error: "You are not authorized." };

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
 *  Creating a field requires admin (RLS on custom_field_defs); the inline
 *  dialog is only offered to admins and the import wizard's "newcustom"
 *  path is gated the same way in importLeads. Limits the type set to the
 *  four primitive types since picking options for a "select" field
 *  requires more UI than the inline dialog should carry. */
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
  const auth = await requireAdmin(supabase);
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
  const auth = await requireAdmin(supabase);
  if ("error" in auth) return { error: auth.error };

  const name = input.name.trim();
  if (!name) return { error: "Enter a field name." };

  const { error } = await supabase
    .from("custom_field_defs")
    .update({
      name,
      type: input.type,
      required: input.required,
      options: input.type === "select" ? input.options : [],
    })
    .eq("id", id);
  if (error) return { error: "Could not update the field." };

  revalidatePath("/settings/custom-fields");
  return { error: null };
}

export async function deleteCustomField(
  id: string,
): Promise<FieldActionResult> {
  const supabase = await createClient();
  const auth = await requireAdmin(supabase);
  if ("error" in auth) return { error: auth.error };

  const { error } = await supabase
    .from("custom_field_defs")
    .delete()
    .eq("id", id);
  if (error) return { error: "Could not delete the field." };

  revalidatePath("/settings/custom-fields");
  return { error: null };
}

export async function moveCustomField(
  id: string,
  direction: "up" | "down",
): Promise<FieldActionResult> {
  const supabase = await createClient();
  const auth = await requireAdmin(supabase);
  if ("error" in auth) return { error: auth.error };

  const { data: fields } = await supabase
    .from("custom_field_defs")
    .select("id, sort_order")
    .order("sort_order", { ascending: true });
  if (!fields) return { error: "Could not reorder the fields." };

  const index = fields.findIndex((f) => f.id === id);
  const swapWith = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || swapWith < 0 || swapWith >= fields.length) {
    return { error: null };
  }

  const current = fields[index];
  const neighbor = fields[swapWith];
  await supabase
    .from("custom_field_defs")
    .update({ sort_order: neighbor.sort_order })
    .eq("id", current.id);
  await supabase
    .from("custom_field_defs")
    .update({ sort_order: current.sort_order })
    .eq("id", neighbor.id);

  revalidatePath("/settings/custom-fields");
  return { error: null };
}
