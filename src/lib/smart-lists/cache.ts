import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

type Admin = SupabaseClient<Database>;

export type SmartListRefreshSummary = {
  ok: true;
  refreshedLists: number;
  totalMembers: number;
  computedAt: string;
};

/**
 * Rebuild the membership cache for every smart list currently attached to a
 * campaign. Each list is rebuilt atomically by the refresh_smart_list() SQL
 * function (delete + re-insert from its saved recipe). Unattached lists are
 * skipped — nothing reads their members. Called by the cron endpoint and after
 * an attach (inline) so freshly imported leads become callable within minutes.
 */
export async function refreshSmartListMembers(
  admin: Admin,
): Promise<SmartListRefreshSummary> {
  const { data: rows, error } = await admin
    .from("campaigns")
    .select("smart_list_id")
    .not("smart_list_id", "is", null);
  if (error) throw new Error("Could not read attached smart lists.");

  const ids = Array.from(
    new Set(
      (rows ?? [])
        .map((r) => r.smart_list_id)
        .filter((id): id is string => Boolean(id)),
    ),
  );

  let totalMembers = 0;
  for (const id of ids) {
    const { data, error: rpcError } = await admin.rpc("refresh_smart_list", {
      in_id: id,
    });
    if (rpcError) throw new Error(`refresh_smart_list failed for ${id}.`);
    totalMembers += (data as number | null) ?? 0;
  }

  return {
    ok: true,
    refreshedLists: ids.length,
    totalMembers,
    computedAt: new Date().toISOString(),
  };
}
