"use server";

import { revalidatePath } from "next/cache";

import { createClient as createAdminClient } from "@supabase/supabase-js";

import { ensureMetaSyncSecret } from "@/lib/meta/settings";
import { runMetaSync } from "@/lib/meta/sync";
import type { Database } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";

type Result = { error: string | null };

function makeServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  return createAdminClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function currentUserId(): Promise<string | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.id ?? null;
}

/** Connect the signed-in user's OWN Meta ad account. Per-user: their sync
 *  pushes only the leads they own into their own Custom Audience. */
export async function connectMeta(input: {
  adAccountId: string;
  accessToken: string;
  acknowledged: boolean;
}): Promise<Result> {
  const userId = await currentUserId();
  if (!userId) return { error: "You are not signed in." };
  if (!input.acknowledged) {
    return { error: "Please confirm you have the right to use this data." };
  }
  const adAccountId = input.adAccountId.trim();
  const accessToken = input.accessToken.trim();
  if (!adAccountId || !accessToken) {
    return { error: "Ad account ID and access token are both required." };
  }

  const admin = makeServiceClient();
  const now = new Date().toISOString();
  const { error } = await admin.from("user_integrations").upsert(
    {
      user_id: userId,
      meta_ad_account_id: adAccountId,
      meta_access_token: accessToken,
      meta_audience_terms_accepted_at: now,
      meta_connected_at: now,
      meta_last_sync_error: null,
      updated_at: now,
    },
    { onConflict: "user_id" },
  );
  if (error) return { error: "Could not save the Meta connection." };

  // Make sure the workspace sync secret exists so the nightly cron (which
  // iterates every connected user) is enabled.
  await ensureMetaSyncSecret();

  revalidatePath("/settings/integrations");
  return { error: null };
}

export async function disconnectMeta(): Promise<Result> {
  const userId = await currentUserId();
  if (!userId) return { error: "You are not signed in." };
  const admin = makeServiceClient();
  const { error } = await admin
    .from("user_integrations")
    .update({
      meta_access_token: null,
      meta_connected_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);
  if (error) return { error: "Could not disconnect Meta." };
  revalidatePath("/settings/integrations");
  return { error: null };
}

/** Run the signed-in user's own sync now (the "Sync now" button). */
export async function syncMetaNow(): Promise<Result> {
  const userId = await currentUserId();
  if (!userId) return { error: "You are not signed in." };
  const result = await runMetaSync(userId);
  revalidatePath("/settings/integrations");
  return { error: result.ok ? null : (result.error ?? "Sync failed.") };
}
