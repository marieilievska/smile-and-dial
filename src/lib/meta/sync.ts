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

type SyncLead = {
  id: string;
  business_email: string | null;
  business_phone: string | null;
  city: string | null;
  state: string | null;
  deleted_at?: string | null;
  status?: string;
};

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Phone reduced to digits, for comparing against the DNC list regardless of
 *  formatting ("+1 (205) 259-8928" -> "12052598928"). */
function digits(phone: string | null | undefined): string {
  return (phone ?? "").replace(/\D/g, "");
}

/** A hashed row is sendable only when at least one cell is non-empty — Meta
 *  rejects an all-empty row (a lead with no email AND no phone). */
function hasAnyKey(row: string[]): boolean {
  return row.some((cell) => cell !== "");
}

/** Every phone on the workspace DNC list, reduced to digits. DNC lives in the
 *  `dnc_entries` table (keyed by phone) — NOT `leads.status` — so we must check
 *  it here to keep opt-outs out of the ad audience. */
async function loadDncDigits(db: Admin): Promise<Set<string>> {
  const out = new Set<string>();
  let cursor = "";
  for (;;) {
    let q = db
      .from("dnc_entries")
      .select("phone")
      .order("phone", { ascending: true })
      .limit(PAGE);
    if (cursor) q = q.gt("phone", cursor);
    const { data } = await q;
    if (!data || data.length === 0) break;
    cursor = data[data.length - 1].phone;
    for (const e of data) {
      const d = digits(e.phone);
      if (d) out.add(d);
    }
    if (data.length < PAGE) break;
  }
  return out;
}

/** Send hashed rows in <=10k batches. Returns an error string on failure. */
async function pushBatches(
  op: "add" | "remove",
  audienceId: string,
  token: string,
  rows: string[][],
): Promise<string | null> {
  const sendable = rows.filter(hasAnyKey);
  for (const batch of chunk(sendable, META_BATCH)) {
    const res =
      op === "add"
        ? await addUsers(audienceId, token, batch)
        : await removeUsers(audienceId, token, batch);
    if (!res.ok) return res.error;
  }
  return null;
}

/** A lead should NOT be in the audience: deleted, DNC (status or phone on the
 *  DNC list), or no email to match on. */
function isIneligible(lead: SyncLead, dnc: Set<string>): boolean {
  if (lead.deleted_at != null) return true;
  if (lead.status === "dnc") return true;
  if (!lead.business_email) return true;
  const d = digits(lead.business_phone);
  return d.length > 0 && dnc.has(d);
}

/**
 * Push eligible leads (email present, not deleted, not DNC by status OR phone)
 * into the Custom Audience and remove any previously-synced lead that became
 * ineligible. Both passes use keyset (id-cursor) pagination so stamping rows
 * mid-pass can't make offset windows skip rows. Returns counts; writes status
 * back to app_settings.
 */
export async function runMetaSync(): Promise<MetaSyncResult> {
  const s = await getMetaSettings();
  if (!s.accessToken || !s.adAccountId) {
    return { ok: false, added: 0, removed: 0, error: "Meta is not connected." };
  }
  const token = s.accessToken;
  const db = admin();

  // Ensure the audience exists (create on first run).
  let audienceId = s.customAudienceId;
  if (!audienceId) {
    const created = await createAudience(
      s.adAccountId,
      token,
      "Smile & Dial — All Leads",
    );
    if (!created.ok) {
      await patchMetaSettings({ meta_last_sync_error: created.error });
      return { ok: false, added: 0, removed: 0, error: created.error };
    }
    audienceId = created.data.id;
    await patchMetaSettings({ meta_custom_audience_id: audienceId });
  }

  const dnc = await loadDncDigits(db);
  let added = 0;
  let removed = 0;

  // --- ADD: not-yet-synced, eligible leads (keyset by id) ---
  let addCursor = "";
  for (;;) {
    let q = db
      .from("leads")
      .select("id, business_email, business_phone, city, state")
      .is("deleted_at", null)
      .neq("status", "dnc")
      .not("business_email", "is", null)
      .is("meta_synced_at", null)
      .order("id", { ascending: true })
      .limit(PAGE);
    if (addCursor) q = q.gt("id", addCursor);
    const { data: rows } = await q;
    if (!rows || rows.length === 0) break;
    addCursor = rows[rows.length - 1].id;

    // Drop DNC-by-phone leads here (can't express "phone in dnc_entries" in the
    // query). They stay unsynced; the id cursor has already moved past them, so
    // they won't be re-fetched into an infinite loop.
    const keep = (rows as SyncLead[]).filter(
      (r) => !dnc.has(digits(r.business_phone)),
    );
    if (keep.length > 0) {
      const hashed = keep.map((r) => leadToHashedRow(r as LeadForAudience));
      const err = await pushBatches("add", audienceId, token, hashed);
      if (err) {
        await patchMetaSettings({ meta_last_sync_error: err });
        return { ok: false, added, removed, error: err };
      }
      await db
        .from("leads")
        .update({ meta_synced_at: new Date().toISOString() })
        .in(
          "id",
          keep.map((r) => r.id),
        );
      added += keep.length;
    }
    if (rows.length < PAGE) break;
  }

  // --- REMOVE: previously-synced leads now ineligible (keyset by id) ---
  let remCursor = "";
  for (;;) {
    let q = db
      .from("leads")
      .select(
        "id, business_email, business_phone, city, state, deleted_at, status",
      )
      .not("meta_synced_at", "is", null)
      .order("id", { ascending: true })
      .limit(PAGE);
    if (remCursor) q = q.gt("id", remCursor);
    const { data: rows } = await q;
    if (!rows || rows.length === 0) break;
    remCursor = rows[rows.length - 1].id;

    const gone = (rows as SyncLead[]).filter((r) => isIneligible(r, dnc));
    if (gone.length > 0) {
      const hashed = gone.map((r) => leadToHashedRow(r as LeadForAudience));
      const err = await pushBatches("remove", audienceId, token, hashed);
      if (err) {
        await patchMetaSettings({ meta_last_sync_error: err });
        return { ok: false, added, removed, error: err };
      }
      await db
        .from("leads")
        .update({ meta_synced_at: null })
        .in(
          "id",
          gone.map((r) => r.id),
        );
      removed += gone.length;
    }
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
