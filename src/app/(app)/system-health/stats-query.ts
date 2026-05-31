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

export type Severity = "info" | "warn" | "error";

export type KindCount = {
  kind: string;
  count: number;
  severity: Severity;
};

export type SystemHealthStats = {
  /** Counts within the last 24h, by severity. */
  errors24h: number;
  warns24h: number;
  info24h: number;
  total24h: number;
  /** Same counts for the *previous* 24h window (24–48h ago), so the
   *  stat strip can show a vs-yesterday delta. */
  prevErrors24h: number;
  prevWarns24h: number;
  prevTotal24h: number;
  /** Events per hour across the last 24h, oldest → newest (length 24).
   *  Powers the sparkline on the Events tile. */
  hourly: number[];
  /** Event kinds in the last 24h, count-descending, for the
   *  "what's happening" breakdown. */
  byKind: KindCount[];
  /** ISO of the most recent event, or null if no events at all. */
  lastEventAt: string | null;
};

/** Headline stats for the stat strip + verdict banner + kind
 *  breakdown. One query over the last 48h (so we can split into the
 *  current and previous 24h windows for a delta); everything else is
 *  a pure JS rollup since severity isn't stored. */
export async function fetchSystemHealthStats(
  supabase: SupabaseClient,
): Promise<SystemHealthStats> {
  const now = new Date();
  const since48 = new Date(now);
  since48.setUTCHours(since48.getUTCHours() - 48);
  const cut24Ms = now.getTime() - 24 * 60 * 60 * 1000;

  const { data } = await supabase
    .from("system_events")
    .select("kind, created_at")
    .gte("created_at", since48.toISOString());

  let errors = 0;
  let warns = 0;
  let info = 0;
  let prevErrors = 0;
  let prevWarns = 0;
  let prevTotal = 0;
  let lastEventAt: string | null = null;
  const hourly = new Array<number>(24).fill(0);
  const kindMap = new Map<string, number>();

  for (const row of data ?? []) {
    const r = row as { kind: string; created_at: string };
    const sev = SEVERITY_BY_KIND[r.kind] ?? "info";
    const t = new Date(r.created_at).getTime();
    if (t >= cut24Ms) {
      // Current 24h window.
      if (sev === "error") errors += 1;
      else if (sev === "warn") warns += 1;
      else info += 1;
      if (!lastEventAt || r.created_at > lastEventAt) {
        lastEventAt = r.created_at;
      }
      kindMap.set(r.kind, (kindMap.get(r.kind) ?? 0) + 1);
      const hoursAgo = Math.floor((now.getTime() - t) / (60 * 60 * 1000));
      // Bucket 23 = most recent hour; 0 = ~24h ago. So the array reads
      // oldest → newest for a left-to-right sparkline.
      const idx = 23 - Math.min(23, Math.max(0, hoursAgo));
      hourly[idx] += 1;
    } else {
      // Previous 24h window (24–48h ago).
      if (sev === "error") prevErrors += 1;
      else if (sev === "warn") prevWarns += 1;
      prevTotal += 1;
    }
  }

  const byKind: KindCount[] = Array.from(kindMap.entries())
    .map(([kind, count]) => ({
      kind,
      count,
      severity: SEVERITY_BY_KIND[kind] ?? "info",
    }))
    .sort((a, b) => b.count - a.count);

  return {
    errors24h: errors,
    warns24h: warns,
    info24h: info,
    total24h: errors + warns + info,
    prevErrors24h: prevErrors,
    prevWarns24h: prevWarns,
    prevTotal24h: prevTotal,
    hourly,
    byKind,
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
