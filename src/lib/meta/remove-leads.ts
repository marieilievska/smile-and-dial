import "server-only";

import { createClient } from "@supabase/supabase-js";

import { leadToHashedRow, type LeadForAudience } from "./audience-fields";
import { META_BATCH, removeUsers } from "./api";
import { getUserMetaSettings } from "./settings";
import type { Database } from "@/lib/supabase/database.types";

type Admin = ReturnType<typeof createClient<Database>>;

export type SyncedLead = LeadForAudience & {
  owner_id: string;
  meta_synced_at: string | null;
};

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Best-effort: remove the given Meta-synced leads from their OWNERS' Custom
 * Audiences before the leads are deleted — otherwise they'd be stranded in the
 * audience with no row left for the sync to remove. Leads that were never
 * synced, and owners with no Meta connection, are skipped. Never throws.
 */
export async function removeLeadsFromOwnerAudiences(
  admin: Admin,
  leads: SyncedLead[],
): Promise<void> {
  const synced = leads.filter((l) => l.meta_synced_at);
  if (synced.length === 0) return;

  const byOwner = new Map<string, SyncedLead[]>();
  for (const l of synced) {
    const arr = byOwner.get(l.owner_id) ?? [];
    arr.push(l);
    byOwner.set(l.owner_id, arr);
  }

  for (const [ownerId, ownerLeads] of byOwner) {
    try {
      const s = await getUserMetaSettings(ownerId);
      if (!s.accessToken || !s.customAudienceId) continue;
      const rows = ownerLeads.map((l) => leadToHashedRow(l));
      for (const batch of chunk(rows, META_BATCH)) {
        await removeUsers(s.customAudienceId, s.accessToken, batch);
      }
    } catch {
      // best-effort — never block a deletion on a Meta hiccup
    }
  }
}
