"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";

import { ID_CHUNK, chunk } from "./chunk";

type BulkResult = { error: string | null };

/** Move every selected lead onto a different list. */
export async function bulkMoveToList(input: {
  leadIds: string[];
  listId: string;
}): Promise<BulkResult> {
  if (input.leadIds.length === 0) return { error: "No leads selected." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { data: list } = await supabase
    .from("lists")
    .select("id")
    .eq("id", input.listId)
    .maybeSingle();
  if (!list) return { error: "Choose a valid list." };

  for (const ids of chunk(input.leadIds, ID_CHUNK)) {
    const { error } = await supabase
      .from("leads")
      .update({ list_id: input.listId })
      .in("id", ids);
    if (error) return { error: "Could not move the leads." };
  }

  revalidatePath("/leads");
  return { error: null };
}

/** Reassign every selected lead to a different owner. Admins only. */
export async function bulkReassignOwner(input: {
  leadIds: string[];
  ownerId: string;
}): Promise<BulkResult> {
  if (input.leadIds.length === 0) return { error: "No leads selected." };

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
    return { error: "Only admins can reassign leads." };
  }

  const { data: owner } = await supabase
    .from("profiles")
    .select("id")
    .eq("id", input.ownerId)
    .maybeSingle();
  if (!owner) return { error: "Choose a valid owner." };

  for (const ids of chunk(input.leadIds, ID_CHUNK)) {
    const { error } = await supabase
      .from("leads")
      .update({ owner_id: input.ownerId })
      .in("id", ids);
    if (error) return { error: "Could not reassign the leads." };
  }

  revalidatePath("/leads");
  return { error: null };
}

/** Soft-delete every selected lead (hidden from the Leads page). */
export async function bulkDeleteLeads(input: {
  leadIds: string[];
}): Promise<BulkResult> {
  if (input.leadIds.length === 0) return { error: "No leads selected." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const deletedAt = new Date().toISOString();
  for (const ids of chunk(input.leadIds, ID_CHUNK)) {
    const { error } = await supabase
      .from("leads")
      .update({ deleted_at: deletedAt })
      .in("id", ids);
    if (error) return { error: "Could not delete the leads." };
  }

  revalidatePath("/leads");
  return { error: null };
}
