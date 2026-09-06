import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Json } from "@/lib/supabase/database.types";

type Admin = SupabaseClient<Database>;

export type SmartListRefreshFailure = {
  id: string;
  name: string;
  error: string;
};

export type SmartListRefreshSummary = {
  /** True when every attached list rebuilt. */
  ok: boolean;
  /** Lists whose membership cache was rebuilt this pass. */
  refreshed: number;
  /** Lists whose refresh_smart_list() call errored (their cache is stale). */
  failed: number;
  totalMembers: number;
  failures: SmartListRefreshFailure[];
  computedAt: string;
};

/** system_events kind written when a list's refresh fails. */
export const SMART_LIST_REFRESH_FAILED_KIND = "smart_list_refresh_failed";

/** One audit row per list per hour. The cron fires every 3 minutes, so a
 *  list that keeps failing would otherwise write 20 rows an hour into the
 *  Activity feed. The stale marker on the list itself is updated every time. */
export const REFRESH_FAILURE_EVENT_THROTTLE_MS = 60 * 60 * 1000;

/** Keep the stored error readable; Postgres messages can run long. */
const MAX_STORED_ERROR_CHARS = 500;

/**
 * Rebuild the membership cache for every smart list currently attached to a
 * campaign. Each list is rebuilt atomically by the refresh_smart_list() SQL
 * function (delete + re-insert from its saved recipe, then it stamps
 * smart_lists.last_refreshed_at). Unattached lists are skipped — nothing reads
 * their members. Called by the cron endpoint and after an attach (inline) so
 * freshly imported leads become callable within minutes.
 *
 * A failure on one list never stops the others: it is recorded on the list
 * (last_refresh_error, so the picker can say "Refresh failed") and as a
 * throttled system_events row, then the loop continues. The caller gets the
 * full tally back instead of an exception for the first bad list.
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

  // Names only decorate the failure record; a miss here must not block the
  // refresh itself.
  const nameById = new Map<string, string>();
  if (ids.length > 0) {
    const { data: lists } = await admin
      .from("smart_lists")
      .select("id, name")
      .in("id", ids);
    for (const l of lists ?? []) nameById.set(l.id, l.name);
  }

  let totalMembers = 0;
  const failures: SmartListRefreshFailure[] = [];
  for (const id of ids) {
    const name = nameById.get(id) ?? id;
    let failure: string | null = null;
    try {
      const { data, error: rpcError } = await admin.rpc("refresh_smart_list", {
        in_id: id,
      });
      if (rpcError) {
        failure = rpcError.message || "refresh_smart_list failed";
      } else {
        totalMembers += (data as number | null) ?? 0;
      }
    } catch (err) {
      failure =
        err instanceof Error ? err.message : "refresh_smart_list failed";
    }
    if (failure === null) continue;
    failures.push({ id, name, error: failure });
    await recordRefreshFailure(admin, id, name, failure);
  }

  return {
    ok: failures.length === 0,
    refreshed: ids.length - failures.length,
    failed: failures.length,
    totalMembers,
    failures,
    computedAt: new Date().toISOString(),
  };
}

/**
 * Mark a list stale and (at most hourly) log the failure. Best-effort: this
 * is bookkeeping about a failure, so it must never turn into a second one.
 * last_refreshed_at is deliberately left alone — it still says when the cache
 * was last GOOD, which is exactly what "stale since" needs.
 */
async function recordRefreshFailure(
  admin: Admin,
  id: string,
  name: string,
  message: string,
): Promise<void> {
  const error = message.slice(0, MAX_STORED_ERROR_CHARS);
  try {
    await admin
      .from("smart_lists")
      .update({ last_refresh_error: error })
      .eq("id", id);
  } catch {
    // best-effort
  }

  try {
    const since = new Date(
      Date.now() - REFRESH_FAILURE_EVENT_THROTTLE_MS,
    ).toISOString();
    const { data: recent } = await admin
      .from("system_events")
      .select("id")
      .eq("kind", SMART_LIST_REFRESH_FAILED_KIND)
      .eq("ref_id", id)
      .gte("created_at", since)
      .limit(1);
    if (recent && recent.length > 0) return;
    await admin.from("system_events").insert({
      kind: SMART_LIST_REFRESH_FAILED_KIND,
      actor_user_id: null,
      ref_table: "smart_lists",
      ref_id: id,
      payload: { name, error } as Json,
    });
  } catch {
    // best-effort
  }
}
