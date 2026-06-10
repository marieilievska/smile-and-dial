import "server-only";

import { createClient } from "@supabase/supabase-js";

import {
  computeConnectHeatmap,
  type ConnectHeatmap,
} from "@/lib/dialer/best-time";
import type { Database } from "@/lib/supabase/database.types";

type SupabaseAdmin = ReturnType<typeof createClient<Database>>;

/**
 * Recompute the connect heatmap from scratch and write it into the
 * `app_settings` singleton. This is the EXPENSIVE path (it scans up to 90 days
 * of historical calls) and is meant to run once a day from a cron — the retry
 * engine never calls this on the hot path, it only `loadCachedHeatmap`s.
 *
 * Patches the singleton with the same `.update(...).not("id","is",null)` pattern
 * the other app_settings writers use. Returns a tiny summary the refresh route
 * can echo back.
 */
export async function refreshBestTimeHeatmap(
  supabase: SupabaseAdmin,
): Promise<{ ok: true; computedAt: string }> {
  const heatmap = await computeConnectHeatmap(supabase);
  const computedAt = new Date().toISOString();
  const { error } = await supabase
    .from("app_settings")
    .update({
      best_time_heatmap: heatmap,
      best_time_heatmap_at: computedAt,
    } as never)
    .not("id", "is", null);
  if (error) {
    throw new Error(`refreshBestTimeHeatmap: ${error.message}`);
  }
  return { ok: true, computedAt };
}

/**
 * Read the cached heatmap from `app_settings`. Returns `null` when the cache is
 * absent (never refreshed yet) or the stored JSON isn't a usable 7×24 grid, so
 * every caller can safely fall back to its default behavior. Never throws on a
 * malformed cache — smart scheduling must degrade gracefully, not break dialing.
 */
export async function loadCachedHeatmap(
  supabase: SupabaseAdmin,
): Promise<ConnectHeatmap | null> {
  const { data, error } = await supabase
    .from("app_settings")
    .select("best_time_heatmap")
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;

  const raw = (data as { best_time_heatmap: unknown }).best_time_heatmap;
  if (!raw) return null;

  // Tolerate a JSON string as well as an already-parsed array (jsonb usually
  // comes back parsed, but stay defensive).
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }

  if (!isConnectHeatmap(parsed)) return null;
  return parsed;
}

/** Shallow shape-check: a 7-row grid of 24 buckets each with numeric fields. */
function isConnectHeatmap(value: unknown): value is ConnectHeatmap {
  if (!Array.isArray(value) || value.length !== 7) return false;
  for (const row of value) {
    if (!Array.isArray(row) || row.length !== 24) return false;
    for (const bucket of row) {
      if (
        typeof bucket !== "object" ||
        bucket === null ||
        typeof (bucket as { rate?: unknown }).rate !== "number" ||
        typeof (bucket as { dialed?: unknown }).dialed !== "number"
      ) {
        return false;
      }
    }
  }
  return true;
}
