import "server-only";

import { randomUUID } from "node:crypto";

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

/**
 * Meta config is PER-USER (stored on user_integrations): each account connects
 * its own ad account + token and its sync pushes only the leads it owns into
 * its own Custom Audience. The one exception is the sync secret, which is
 * workspace-level: the nightly cron authenticates once with it and then
 * iterates every user who has connected Meta.
 */
export type MetaSettings = {
  adAccountId: string | null;
  accessToken: string | null;
  customAudienceId: string | null;
  connectedAt: string | null;
  lastSyncAt: string | null;
  lastSyncCount: number;
  lastSyncError: string | null;
};

/** Read one user's Meta connection from their user_integrations row. */
export async function getUserMetaSettings(
  userId: string,
): Promise<MetaSettings> {
  const { data } = await admin()
    .from("user_integrations")
    .select(
      "meta_ad_account_id, meta_access_token, meta_custom_audience_id, meta_connected_at, meta_last_sync_at, meta_last_sync_count, meta_last_sync_error",
    )
    .eq("user_id", userId)
    .maybeSingle();
  return {
    adAccountId: data?.meta_ad_account_id ?? null,
    accessToken: data?.meta_access_token ?? null,
    customAudienceId: data?.meta_custom_audience_id ?? null,
    connectedAt: data?.meta_connected_at ?? null,
    lastSyncAt: data?.meta_last_sync_at ?? null,
    lastSyncCount: data?.meta_last_sync_count ?? 0,
    lastSyncError: data?.meta_last_sync_error ?? null,
  };
}

/** Patch one user's Meta columns on their user_integrations row. */
export async function patchUserMetaSettings(
  userId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await admin()
    .from("user_integrations")
    .update({ ...patch, updated_at: new Date().toISOString() } as never)
    .eq("user_id", userId);
}

/** Every user id that currently has Meta connected (token present). The cron
 *  iterates these, syncing each into their own audience. */
export async function listMetaConnectedUserIds(): Promise<string[]> {
  const { data } = await admin()
    .from("user_integrations")
    .select("user_id")
    .not("meta_connected_at", "is", null)
    .not("meta_access_token", "is", null);
  return (data ?? []).map((r) => r.user_id);
}

/** The workspace-level sync secret the cron uses to authenticate. Lives on
 *  app_settings because the cron is a single job, not a per-user thing. */
export async function getMetaSyncSecret(): Promise<string | null> {
  const { data } = await admin()
    .from("app_settings")
    .select("meta_sync_secret")
    .eq("id", 1)
    .maybeSingle();
  return data?.meta_sync_secret ?? null;
}

/** Make sure the workspace sync secret exists so the nightly cron is enabled.
 *  Called when any user connects Meta; generates one once if missing. */
export async function ensureMetaSyncSecret(): Promise<void> {
  const existing = await getMetaSyncSecret();
  if (existing) return;
  await admin()
    .from("app_settings")
    .update({ meta_sync_secret: randomUUID() } as never)
    .eq("id", 1);
}
