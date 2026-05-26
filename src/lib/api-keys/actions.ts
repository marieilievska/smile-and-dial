"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";

import { generateApiKey } from "./generator";

export type CreatedApiKey = { rawKey: string; id: string; name: string };

/** Create a new API key for the signed-in user. Returns the raw key once
 *  (the only chance for the user to copy it). Subsequent reads only see
 *  the prefix. */
export async function createApiKey(input: { name: string }): Promise<{
  error: string | null;
  key?: CreatedApiKey;
}> {
  const name = input.name?.trim();
  if (!name) return { error: "Name is required." };
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { rawKey, keyPrefix, keyHash } = generateApiKey();
  const { data, error } = await supabase
    .from("api_keys")
    .insert({
      owner_id: user.id,
      name,
      key_prefix: keyPrefix,
      key_hash: keyHash,
    })
    .select("id, name")
    .single();
  if (error || !data) return { error: "Could not create the API key." };

  revalidatePath("/settings/api");
  return {
    error: null,
    key: { rawKey, id: data.id, name: data.name },
  };
}

/** Revoke an API key. Soft revoke — sets revoked_at; row stays for audit. */
export async function revokeApiKey(input: {
  apiKeyId: string;
}): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { error } = await supabase
    .from("api_keys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", input.apiKeyId)
    .eq("owner_id", user.id)
    .is("revoked_at", null);
  if (error) return { error: "Could not revoke." };
  revalidatePath("/settings/api");
  return { error: null };
}
