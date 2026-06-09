import "server-only";

import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

type Admin = ReturnType<typeof createClient<Database>>;

function admin(): Admin {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) throw new Error("Supabase service role env missing.");
  return createClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export type MetaSettings = {
  adAccountId: string | null;
  accessToken: string | null;
  customAudienceId: string | null;
  connectedAt: string | null;
  lastSyncAt: string | null;
  lastSyncCount: number;
  lastSyncError: string | null;
  syncSecret: string | null;
};

export async function getMetaSettings(): Promise<MetaSettings> {
  const { data } = await admin()
    .from("app_settings")
    .select(
      "meta_ad_account_id, meta_access_token, meta_custom_audience_id, meta_connected_at, meta_last_sync_at, meta_last_sync_count, meta_last_sync_error, meta_sync_secret",
    )
    .limit(1)
    .maybeSingle();
  return {
    adAccountId: data?.meta_ad_account_id ?? null,
    accessToken: data?.meta_access_token ?? null,
    customAudienceId: data?.meta_custom_audience_id ?? null,
    connectedAt: data?.meta_connected_at ?? null,
    lastSyncAt: data?.meta_last_sync_at ?? null,
    lastSyncCount: data?.meta_last_sync_count ?? 0,
    lastSyncError: data?.meta_last_sync_error ?? null,
    syncSecret: data?.meta_sync_secret ?? null,
  };
}

/** Patch the singleton app_settings row (there is exactly one). */
export async function patchMetaSettings(
  patch: Record<string, unknown>,
): Promise<void> {
  await admin()
    .from("app_settings")
    .update(patch as never)
    .not("id", "is", null);
}
