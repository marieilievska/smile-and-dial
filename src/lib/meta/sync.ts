import "server-only";

import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

import { leadToHashedRow, type LeadForAudience } from "./audience-fields";
import { addUsers, createAudience, META_BATCH, removeUsers } from "./api";
import { getMetaSettings, patchMetaSettings } from "./settings";

type Admin = ReturnType<typeof createClient<Database>>;
const PAGE = 1000;

function admin(): Admin {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  return createClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export type MetaSyncResult = {
  ok: boolean;
  added: number;
  removed: number;
  error: string | null;
};

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Push eligible leads (email present, not DNC, not deleted) into the Custom
 * Audience and remove any previously-synced lead that became ineligible.
 * Returns counts; writes status back to app_settings.
 */
export async function runMetaSync(): Promise<MetaSyncResult> {
  const s = await getMetaSettings();
  if (!s.accessToken || !s.adAccountId) {
    return { ok: false, added: 0, removed: 0, error: "Meta is not connected." };
  }
  const db = admin();

  // Ensure the audience exists (create on first run).
  let audienceId = s.customAudienceId;
  if (!audienceId) {
    const created = await createAudience(
      s.adAccountId,
      s.accessToken,
      "Smile & Dial — All Leads",
    );
    if (!created.ok) {
      await patchMetaSettings({ meta_last_sync_error: created.error });
      return { ok: false, added: 0, removed: 0, error: created.error };
    }
    audienceId = created.data.id;
    await patchMetaSettings({ meta_custom_audience_id: audienceId });
  }

  let added = 0;
  let removed = 0;

  // --- ADD: eligible leads not yet synced ---
  for (let from = 0; ; from += PAGE) {
    const { data: rows } = await db
      .from("leads")
      .select("id, business_email, business_phone, city, state")
      .is("deleted_at", null)
      .neq("status", "dnc")
      .not("business_email", "is", null)
      .is("meta_synced_at", null)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (!rows || rows.length === 0) break;

    const hashed = rows.map((r) => leadToHashedRow(r as LeadForAudience));
    for (const batch of chunk(hashed, META_BATCH)) {
      const res = await addUsers(audienceId, s.accessToken, batch);
      if (!res.ok) {
        await patchMetaSettings({ meta_last_sync_error: res.error });
        return { ok: false, added, removed, error: res.error };
      }
    }
    const ids = rows.map((r) => (r as { id: string }).id);
    await db
      .from("leads")
      .update({ meta_synced_at: new Date().toISOString() })
      .in("id", ids);
    added += rows.length;
    if (rows.length < PAGE) break;
  }

  // --- REMOVE: previously-synced leads now ineligible (deleted / dnc / no email) ---
  for (;;) {
    const { data: rows } = await db
      .from("leads")
      .select(
        "id, business_email, business_phone, city, state, deleted_at, status",
      )
      .not("meta_synced_at", "is", null)
      .or("deleted_at.not.is.null,status.eq.dnc,business_email.is.null")
      .order("id", { ascending: true })
      .limit(PAGE);
    if (!rows || rows.length === 0) break;

    const hashed = rows.map((r) => leadToHashedRow(r as LeadForAudience));
    for (const batch of chunk(hashed, META_BATCH)) {
      const res = await removeUsers(audienceId, s.accessToken, batch);
      if (!res.ok) {
        await patchMetaSettings({ meta_last_sync_error: res.error });
        return { ok: false, added, removed, error: res.error };
      }
    }
    const ids = rows.map((r) => (r as { id: string }).id);
    await db.from("leads").update({ meta_synced_at: null }).in("id", ids);
    removed += rows.length;
    if (rows.length < PAGE) break;
  }

  // Total currently-synced count for the status line.
  const { count } = await db
    .from("leads")
    .select("id", { count: "exact", head: true })
    .not("meta_synced_at", "is", null);

  await patchMetaSettings({
    meta_last_sync_at: new Date().toISOString(),
    meta_last_sync_count: count ?? 0,
    meta_last_sync_error: null,
  });

  return { ok: true, added, removed, error: null };
}
