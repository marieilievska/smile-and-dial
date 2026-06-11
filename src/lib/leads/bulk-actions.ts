"use server";

import { revalidatePath } from "next/cache";

import { createClient as createAdminClient } from "@supabase/supabase-js";

import { hardDeleteCalls } from "@/lib/calls/delete-calls-core";
import { removeLeadsFromOwnerAudiences } from "@/lib/meta/remove-leads";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/database.types";

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

/**
 * Permanently delete every selected lead and everything tied to it: calls (+
 * recordings), callbacks, custom-field values, emails. Synced leads are pulled
 * out of their owner's Meta audience first so they don't linger there. No undo.
 *
 * Permission: a user may delete leads they own; admins may delete any. The
 * cross-table delete runs under the service role (calls have no delete RLS),
 * but only after confirming ownership.
 */
export async function bulkDeleteLeads(input: {
  leadIds: string[];
}): Promise<BulkResult> {
  const ids = [...new Set(input.leadIds.filter(Boolean))];
  if (ids.length === 0) return { error: "No leads selected." };

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
  const isAdmin = me?.role === "admin";

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) return { error: "Server is missing Supabase credentials." };
  const admin = createAdminClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Load the targets (for the ownership check + Meta cleanup).
  const targets: {
    id: string;
    owner_id: string;
    business_email: string | null;
    business_phone: string | null;
    city: string | null;
    state: string | null;
    meta_synced_at: string | null;
  }[] = [];
  for (const idsChunk of chunk(ids, ID_CHUNK)) {
    const { data } = await admin
      .from("leads")
      .select(
        "id, owner_id, business_email, business_phone, city, state, meta_synced_at",
      )
      .in("id", idsChunk);
    targets.push(...(data ?? []));
  }
  if (targets.length === 0) return { error: null };

  // Non-admins may only delete leads they own.
  if (!isAdmin && targets.some((l) => l.owner_id !== user.id)) {
    return { error: "You can only delete leads you own." };
  }

  // 1) Pull synced leads out of their owners' Meta audiences (best-effort).
  await removeLeadsFromOwnerAudiences(admin, targets);

  // 2) Delete their calls first — calls.lead_id is ON DELETE RESTRICT.
  const callIds: string[] = [];
  for (const idsChunk of chunk(ids, ID_CHUNK)) {
    const { data: cs } = await admin
      .from("calls")
      .select("id")
      .in("lead_id", idsChunk);
    for (const c of cs ?? []) callIds.push(c.id);
  }
  const del = await hardDeleteCalls(admin, callIds);
  if (del.error) return { error: "Could not delete the leads' calls." };

  // 3) Delete the lead rows — callbacks / custom values / emails cascade.
  for (const idsChunk of chunk(ids, ID_CHUNK)) {
    const { error } = await admin.from("leads").delete().in("id", idsChunk);
    if (error) return { error: "Could not delete the leads." };
  }

  revalidatePath("/leads");
  revalidatePath("/calls");
  revalidatePath("/analytics");
  revalidatePath("/costs");
  revalidatePath("/today");
  return { error: null };
}
