"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";

import { getOrganizationUri, isCalendlyLive, listEventTypes } from "./api";

function makeServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  return createAdminClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** Pull the organization's active event types from Calendly into the local
 *  cache that powers the campaign-settings dropdown + the booking tools. */
async function syncEventTypes(
  admin: ReturnType<typeof makeServiceClient>,
  organizationUri: string,
): Promise<void> {
  const types = await listEventTypes(organizationUri);
  if (types.length === 0) return;
  await admin.from("calendly_event_types").upsert(
    types.map((t) => ({
      event_uri: t.uri,
      name: t.name,
      scheduling_url: t.schedulingUrl,
      duration_minutes: t.durationMinutes,
      active: true,
      synced_at: new Date().toISOString(),
    })),
    { onConflict: "event_uri" },
  );
}

/** Connect Calendly. In live mode (CALENDLY_LIVE=live) this would kick off
 *  the OAuth dance; in mock mode we just stamp the connected_at timestamp
 *  and seed a couple of fake event types so the UI has something to render
 *  and the campaign-settings dropdown can pick from. */
export async function connectCalendlyMock(): Promise<{ error: string | null }> {
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
  if (me?.role !== "admin") return { error: "Admins only." };

  const admin = makeServiceClient();
  const now = new Date().toISOString();

  // Live: verify the token, store the org URI, and pull real event types.
  // We deliberately don't persist the PAT in the DB — it lives in env.
  if (isCalendlyLive()) {
    const orgUri = await getOrganizationUri();
    if (!orgUri) {
      return {
        error:
          "Couldn't reach Calendly with the configured token. Check CALENDLY_API_KEY.",
      };
    }
    await admin
      .from("app_settings")
      .update({
        calendly_organization_uri: orgUri,
        calendly_connected_at: now,
        calendly_last_sync_at: now,
      })
      .eq("id", 1);
    await syncEventTypes(admin, orgUri);
    revalidatePath("/settings/integrations");
    return { error: null };
  }

  await admin
    .from("app_settings")
    .update({
      calendly_access_token: "mock-access-token",
      calendly_refresh_token: "mock-refresh-token",
      calendly_organization_uri:
        "https://api.calendly.com/organizations/mock-org",
      calendly_user_uri: "https://api.calendly.com/users/mock-user",
      calendly_connected_at: now,
      calendly_last_sync_at: now,
    })
    .eq("id", 1);

  // Seed two mock event types so the campaign-settings dropdown isn't empty.
  await admin.from("calendly_event_types").upsert(
    [
      {
        event_uri: "https://api.calendly.com/event_types/mock-discovery",
        name: "Mock Discovery Call",
        scheduling_url: "https://calendly.com/mock/discovery",
        duration_minutes: 30,
        active: true,
      },
      {
        event_uri: "https://api.calendly.com/event_types/mock-strategy",
        name: "Mock Strategy Call",
        scheduling_url: "https://calendly.com/mock/strategy",
        duration_minutes: 60,
        active: true,
      },
    ],
    { onConflict: "event_uri" },
  );

  revalidatePath("/settings/integrations");
  return { error: null };
}

/** Pretend to re-sync event types. In live mode this would call Calendly's
 *  list-event-types endpoint; mock mode just bumps the last-sync timestamp. */
export async function syncCalendlyMock(): Promise<{ error: string | null }> {
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
  if (me?.role !== "admin") return { error: "Admins only." };

  const admin = makeServiceClient();

  // Live: re-pull the org's event types from Calendly.
  if (isCalendlyLive()) {
    const orgUri = await getOrganizationUri();
    if (!orgUri) {
      return {
        error:
          "Couldn't reach Calendly with the configured token. Check CALENDLY_API_KEY.",
      };
    }
    await syncEventTypes(admin, orgUri);
    await admin
      .from("app_settings")
      .update({ calendly_last_sync_at: new Date().toISOString() })
      .eq("id", 1);
    revalidatePath("/settings/integrations");
    return { error: null };
  }

  await admin
    .from("app_settings")
    .update({ calendly_last_sync_at: new Date().toISOString() })
    .eq("id", 1);
  revalidatePath("/settings/integrations");
  return { error: null };
}

export async function disconnectCalendly(): Promise<{ error: string | null }> {
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
  if (me?.role !== "admin") return { error: "Admins only." };

  const admin = makeServiceClient();
  await admin
    .from("app_settings")
    .update({
      calendly_access_token: null,
      calendly_refresh_token: null,
      calendly_organization_uri: null,
      calendly_user_uri: null,
      calendly_connected_at: null,
      calendly_last_sync_at: null,
    })
    .eq("id", 1);
  // Mark all event types inactive so the campaign dropdown clears.
  await admin
    .from("calendly_event_types")
    .update({ active: false })
    .eq("active", true);
  revalidatePath("/settings/integrations");
  return { error: null };
}
