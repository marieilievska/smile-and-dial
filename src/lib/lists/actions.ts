"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

export type ListActionResult = { error: string | null };

function makeServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  return createAdminClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** Split an id list into chunks so a `.in(...)` filter can't overflow. */
function chunk<T>(arr: T[], size = 200): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Create a list owned by the current user. */
export async function createList(
  name: string,
  description: string,
): Promise<ListActionResult> {
  const trimmedName = name.trim();
  if (!trimmedName) return { error: "Enter a list name." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { error } = await supabase.from("lists").insert({
    owner_id: user.id,
    name: trimmedName,
    description: description.trim() || null,
  });
  if (error) return { error: "Could not create the list." };

  revalidatePath("/settings/lists");
  return { error: null };
}

/** Create a list and return its id. Mirrors `createList` but surfaces
 *  the new row's id so callers (e.g. the inline-create affordance in
 *  the import wizard) can auto-select it after creation. */
export async function createListInline(
  name: string,
): Promise<{ id: string | null; error: string | null }> {
  const trimmedName = name.trim();
  if (!trimmedName) return { id: null, error: "Enter a list name." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { id: null, error: "You are not signed in." };

  const { data, error } = await supabase
    .from("lists")
    .insert({ owner_id: user.id, name: trimmedName, description: null })
    .select("id")
    .single();
  if (error || !data) return { id: null, error: "Could not create the list." };

  revalidatePath("/settings/lists");
  revalidatePath("/leads/import");
  return { id: data.id, error: null };
}

/** Rename or re-describe a list. RLS limits this to the owner (or an admin). */
export async function updateList(
  id: string,
  name: string,
  description: string,
): Promise<ListActionResult> {
  const trimmedName = name.trim();
  if (!trimmedName) return { error: "Enter a list name." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { error } = await supabase
    .from("lists")
    .update({ name: trimmedName, description: description.trim() || null })
    .eq("id", id);
  if (error) return { error: "Could not update the list." };

  revalidatePath("/settings/lists");
  return { error: null };
}

/**
 * Delete a list AND everything under it. A list can't be dropped while leads
 * still reference it (FK is ON DELETE RESTRICT), and a lead can't be dropped
 * while it has calls (also RESTRICT) — and "deleting" leads in the UI only
 * soft-deletes them, so the rows keep blocking the list. So we cascade
 * explicitly: the list's calls → its leads → the list. (callbacks / emails /
 * custom values cascade with the lead; campaign attachments cascade with the
 * list.) This is destructive and the dialog warns about the lead/call count.
 */
export async function deleteList(id: string): Promise<ListActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  // Only the list's owner (or an admin) may delete it + its leads.
  const [{ data: list }, { data: me }] = await Promise.all([
    supabase.from("lists").select("id, owner_id").eq("id", id).maybeSingle(),
    supabase.from("profiles").select("role").eq("id", user.id).maybeSingle(),
  ]);
  if (!list) return { error: "List not found." };
  if (list.owner_id !== user.id && me?.role !== "admin") {
    return { error: "You don't have permission to delete this list." };
  }

  // Service role for the cascade (deleting calls/leads spans rows the user
  // doesn't directly own under RLS, e.g. cost/system rows).
  const admin = makeServiceClient();
  const { data: leadRows } = await admin
    .from("leads")
    .select("id")
    .eq("list_id", id);
  const leadIds = (leadRows ?? []).map((r) => r.id);

  for (const ids of chunk(leadIds)) {
    // calls is a RESTRICT child of leads — clear it before the leads.
    const { error: callsErr } = await admin
      .from("calls")
      .delete()
      .in("lead_id", ids);
    if (callsErr) return { error: "Could not delete the list's calls." };
  }
  for (const ids of chunk(leadIds)) {
    const { error: leadsErr } = await admin
      .from("leads")
      .delete()
      .in("id", ids);
    if (leadsErr) return { error: "Could not delete the list's leads." };
  }

  const { error } = await admin.from("lists").delete().eq("id", id);
  if (error) return { error: "Could not delete the list." };

  revalidatePath("/settings/lists");
  revalidatePath("/leads");
  return { error: null };
}
