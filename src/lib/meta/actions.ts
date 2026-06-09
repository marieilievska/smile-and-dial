"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";

import { runMetaSync } from "@/lib/meta/sync";
import { createClient } from "@/lib/supabase/server";

type Result = { error: string | null };

/** Admin-only guard. Returns the user id or an error. */
async function requireAdmin(): Promise<
  { userId: string; error: null } | { userId: null; error: string }
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { userId: null, error: "You are not signed in." };
  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (me?.role !== "admin") {
    return { userId: null, error: "Only an admin can manage integrations." };
  }
  return { userId: user.id, error: null };
}

export async function connectMeta(input: {
  adAccountId: string;
  accessToken: string;
  acknowledged: boolean;
}): Promise<Result> {
  const guard = await requireAdmin();
  if (guard.error) return { error: guard.error };
  if (!input.acknowledged) {
    return { error: "Please confirm you have the right to use this data." };
  }
  const adAccountId = input.adAccountId.trim();
  const accessToken = input.accessToken.trim();
  if (!adAccountId || !accessToken) {
    return { error: "Ad account ID and access token are both required." };
  }

  const supabase = await createClient();
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("app_settings")
    .update({
      meta_ad_account_id: adAccountId,
      meta_access_token: accessToken,
      meta_audience_terms_accepted_at: now,
      meta_connected_at: now,
      meta_last_sync_error: null,
      // generate a sync secret once so the nightly cron can authenticate
      meta_sync_secret: randomUUID(),
    } as never)
    .not("id", "is", null);
  if (error) return { error: "Could not save the Meta connection." };

  revalidatePath("/settings/integrations");
  return { error: null };
}

export async function disconnectMeta(): Promise<Result> {
  const guard = await requireAdmin();
  if (guard.error) return { error: guard.error };
  const supabase = await createClient();
  const { error } = await supabase
    .from("app_settings")
    .update({
      meta_access_token: null,
      meta_connected_at: null,
    } as never)
    .not("id", "is", null);
  if (error) return { error: "Could not disconnect Meta." };
  revalidatePath("/settings/integrations");
  return { error: null };
}

export async function syncMetaNow(): Promise<Result> {
  const guard = await requireAdmin();
  if (guard.error) return { error: guard.error };
  const result = await runMetaSync();
  revalidatePath("/settings/integrations");
  return { error: result.ok ? null : (result.error ?? "Sync failed.") };
}
