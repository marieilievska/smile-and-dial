"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";

import { getIdentity, listEventTypes } from "./api";

/**
 * Per-user Calendly connection. Each rep pastes their own Personal Access
 * Token; the AI books on behalf of the campaign owner using their token +
 * event types. Credentials live in user_integrations (per user), and event
 * types in calendly_event_types scoped by owner_id.
 *
 * Reads/writes go through the service role so a non-admin can manage their own
 * connection (and so we can write event types, which are admin-write under
 * RLS) — but every action first resolves the signed-in user and only ever
 * touches that user's own rows.
 */

function makeServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  return createAdminClient(url, key, {
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

/** Pull the user's active event types from Calendly into the per-user cache. */
async function syncUserEventTypes(
  admin: ReturnType<typeof makeServiceClient>,
  userId: string,
  organizationUri: string,
  token: string,
): Promise<void> {
  const types = await listEventTypes(organizationUri, token);
  if (types.length === 0) return;
  await admin.from("calendly_event_types").upsert(
    types.map((t) => ({
      owner_id: userId,
      event_uri: t.uri,
      name: t.name,
      scheduling_url: t.schedulingUrl,
      duration_minutes: t.durationMinutes,
      active: true,
      synced_at: new Date().toISOString(),
    })),
    { onConflict: "owner_id,event_uri" },
  );
}

/** Connect (or re-connect) the signed-in user's Calendly by pasting a token. */
export async function saveCalendlyConnection(
  token: string,
): Promise<{ error: string | null }> {
  const t = token.trim();
  if (!t) return { error: "Paste your Calendly Personal Access Token." };

  const userId = await currentUserId();
  if (!userId) return { error: "You are not signed in." };

  const identity = await getIdentity(t);
  if (!identity.organizationUri) {
    return {
      error:
        "That token didn't work — check it's a valid Calendly Personal Access Token.",
    };
  }

  const admin = makeServiceClient();
  const now = new Date().toISOString();
  const { error } = await admin.from("user_integrations").upsert(
    {
      user_id: userId,
      calendly_api_key: t,
      calendly_organization_uri: identity.organizationUri,
      calendly_user_uri: identity.userUri,
      calendly_connected_at: now,
      calendly_last_sync_at: now,
      updated_at: now,
    },
    { onConflict: "user_id" },
  );
  if (error) return { error: "Couldn't save the connection." };

  await syncUserEventTypes(admin, userId, identity.organizationUri, t);
  revalidatePath("/settings/integrations");
  return { error: null };
}

/** Re-pull the signed-in user's event types from Calendly. */
export async function syncCalendly(): Promise<{ error: string | null }> {
  const userId = await currentUserId();
  if (!userId) return { error: "You are not signed in." };

  const admin = makeServiceClient();
  const { data: integ } = await admin
    .from("user_integrations")
    .select("calendly_api_key, calendly_organization_uri")
    .eq("user_id", userId)
    .maybeSingle();
  const token = integ?.calendly_api_key?.trim();
  const org = integ?.calendly_organization_uri;
  if (!token || !org) return { error: "Connect Calendly first." };

  await syncUserEventTypes(admin, userId, org, token);
  await admin
    .from("user_integrations")
    .update({ calendly_last_sync_at: new Date().toISOString() })
    .eq("user_id", userId);
  revalidatePath("/settings/integrations");
  return { error: null };
}

/** Disconnect the signed-in user's Calendly and deactivate their event types. */
export async function disconnectCalendly(): Promise<{ error: string | null }> {
  const userId = await currentUserId();
  if (!userId) return { error: "You are not signed in." };

  const admin = makeServiceClient();
  await admin
    .from("user_integrations")
    .update({
      calendly_api_key: null,
      calendly_organization_uri: null,
      calendly_user_uri: null,
      calendly_connected_at: null,
      calendly_last_sync_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);
  await admin
    .from("calendly_event_types")
    .update({ active: false })
    .eq("owner_id", userId);
  revalidatePath("/settings/integrations");
  return { error: null };
}
