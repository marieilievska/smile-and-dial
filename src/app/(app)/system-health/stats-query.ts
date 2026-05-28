import type { SupabaseClient } from "@supabase/supabase-js";

/** Severity is derived from kind, not stored. Keep this map in sync
 *  with the one in page.tsx — duplicating it here avoids a circular
 *  import. */
const SEVERITY_BY_KIND: Record<string, "info" | "warn" | "error"> = {
  spend_cap_hit: "warn",
  spend_cap_resumed: "info",
  campaign_paused: "warn",
  number_flagged: "warn",
  connect_rate_low: "warn",
  webhook_error: "error",
  dialer_failure: "error",
  orphan_call: "error",
  integration_disconnected: "warn",
  goal_transition: "info",
  callback_changed: "info",
  outcome_override: "info",
  call_now: "info",
  dnc_removed: "info",
  merge_completed: "info",
};

export type SystemHealthStats = {
  /** Counts within the last 24h, by severity. */
  errors24h: number;
  warns24h: number;
  info24h: number;
  total24h: number;
  /** ISO of the most recent event, or null if no events at all. */
  lastEventAt: string | null;
};

/** Last-24h counts by severity for the stat strip + the most recent
 *  event timestamp. Single query — we walk every row in the 24h
 *  window in JS since the severity isn't stored. */
export async function fetchSystemHealthStats(
  supabase: SupabaseClient,
): Promise<SystemHealthStats> {
  const since = new Date();
  since.setUTCHours(since.getUTCHours() - 24);

  const { data } = await supabase
    .from("system_events")
    .select("kind, created_at")
    .gte("created_at", since.toISOString());

  let errors = 0;
  let warns = 0;
  let info = 0;
  let lastEventAt: string | null = null;
  for (const row of data ?? []) {
    const r = row as { kind: string; created_at: string };
    const sev = SEVERITY_BY_KIND[r.kind] ?? "info";
    if (sev === "error") errors += 1;
    else if (sev === "warn") warns += 1;
    else info += 1;
    if (!lastEventAt || r.created_at > lastEventAt) {
      lastEventAt = r.created_at;
    }
  }

  return {
    errors24h: errors,
    warns24h: warns,
    info24h: info,
    total24h: errors + warns + info,
    lastEventAt,
  };
}

/** Counts of events MATCHING the current filters, grouped by
 *  severity. Used by the segmented severity tabs so each tab shows
 *  its match count.
 *
 *  Caller passes the post-filter rows (the same rows the page
 *  fetches and renders) so we don't double-query — pure JS rollup. */
export function countBySeverity(events: { kind: string }[]): {
  info: number;
  warn: number;
  error: number;
  total: number;
} {
  let info = 0;
  let warn = 0;
  let error = 0;
  for (const e of events) {
    const sev = SEVERITY_BY_KIND[e.kind] ?? "info";
    if (sev === "error") error += 1;
    else if (sev === "warn") warn += 1;
    else info += 1;
  }
  return { info, warn, error, total: info + warn + error };
}

export const SEVERITY_BY_KIND_LOOKUP = SEVERITY_BY_KIND;
