import type { SupabaseClient } from "@supabase/supabase-js";

import { pickBreakdown } from "@/lib/analytics/costs";
import { CONNECTED_OUTCOMES } from "@/lib/calls/outcomes";
import {
  endOfEtDayUtcIso,
  etDateDaysAgo,
  etDayRangeUtc,
  etHour,
  startOfTodayEtIso,
} from "@/lib/time/eastern";

/** Today-page data: three hero counts + an action queue of items that
 *  need the user's attention right now. Pure read-only — no mutations. */

export type HeroCounts = {
  callsToday: number;
  callsYesterday: number;
  connectRateToday: number; // 0..1
  connectRateYesterday: number;
  appointmentsToday: number;
  appointmentsYesterday: number;
  costPerAppointmentToday: number; // 0 when no appts
  pendingCallbacks: number;
  overdueCallbacks: number;
  oldestOverdueMinutes: number | null;
};

export type ActionItem = {
  id: string;
  kind:
    | "overdue_callback"
    | "needs_status_update"
    | "email_reply"
    | "campaign_paused"
    | "number_flagged";
  message: string;
  href: string;
  urgency: "high" | "normal";
  // ISO timestamp for sorting/age.
  at: string;
};

// "Today" boundaries in Eastern time — a call placed at 9pm ET belongs to that
// ET day, not the next UTC day. Every dashboard agrees on the ET calendar day.
function todayStart(): Date {
  return new Date(startOfTodayEtIso());
}

function yesterdayWindow(): { from: string; to: string } {
  const y = etDateDaysAgo(1);
  return { from: etDayRangeUtc(y).startUtc, to: endOfEtDayUtcIso(y) };
}

const CALLS_PAGE = 1000;

/** Page through a `calls` filter past PostgREST's 1,000-row response cap.
 *  Without this the hero counts (calls, connect rate, appointments, spend)
 *  silently undercount on days with >1,000 calls — the exact scale this
 *  dashboard is built for. */
async function fetchAllCalls<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += CALLS_PAGE) {
    const { data } = await build(offset, offset + CALLS_PAGE - 1);
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < CALLS_PAGE) break;
    if (offset > 500_000) break; // safety backstop
  }
  return rows;
}

export async function fetchHeroCounts(
  supabase: SupabaseClient,
  opts: { isAdmin: boolean; ownerId: string },
): Promise<HeroCounts> {
  const start = todayStart();
  const yWindow = yesterdayWindow();

  // Today's + yesterday's calls — RLS scopes for members; admins see
  // everything. Paginated so busy days (>1,000 calls) don't silently
  // undercount every metric derived below.
  const callbacksQuery = supabase
    .from("callbacks")
    .select("id, scheduled_at")
    .eq("status", "pending");

  const [rowsToday, rowsYest, { data: callbacks }] = await Promise.all([
    fetchAllCalls<{
      id: string;
      lead_id: string;
      outcome: string | null;
      goal_met: boolean | null;
      cost_breakdown: unknown;
    }>((from, to) =>
      supabase
        .from("calls")
        .select("id, lead_id, outcome, goal_met, cost_breakdown")
        .gte("created_at", start.toISOString())
        .order("created_at", { ascending: true })
        .range(from, to),
    ),
    fetchAllCalls<{
      id: string;
      lead_id: string;
      outcome: string | null;
      goal_met: boolean | null;
    }>((from, to) =>
      supabase
        .from("calls")
        .select("id, lead_id, outcome, goal_met")
        .gte("created_at", yWindow.from)
        .lte("created_at", yWindow.to)
        .order("created_at", { ascending: true })
        .range(from, to),
    ),
    callbacksQuery,
  ]);

  // Appointments = DISTINCT businesses that met the goal, not goal-met calls, so
  // a lead with two goal-met calls (or two leads merged into one) counts once.
  const distinctGoalLeads = (
    rows: { lead_id: string; goal_met: boolean | null }[],
  ) => new Set(rows.filter((r) => r.goal_met).map((r) => r.lead_id)).size;
  const apptsToday = distinctGoalLeads(rowsToday);
  const apptsYest = distinctGoalLeads(rowsYest);

  const connectedToday = rowsToday.filter(
    (r) => r.outcome && CONNECTED_OUTCOMES.has(r.outcome),
  ).length;
  const connectedYest = rowsYest.filter(
    (r) => r.outcome && CONNECTED_OUTCOMES.has(r.outcome),
  ).length;

  const spendToday = rowsToday.reduce(
    (sum, r) => sum + pickBreakdown(r.cost_breakdown).total,
    0,
  );

  // Callback urgency: pending and scheduled_at <= now is "overdue".
  const now = Date.now();
  const cbRows = callbacks ?? [];
  let overdueCount = 0;
  let oldestOverdueMs = 0;
  for (const cb of cbRows) {
    const t = cb.scheduled_at ? new Date(cb.scheduled_at).getTime() : 0;
    if (t && t < now) {
      overdueCount += 1;
      oldestOverdueMs = Math.max(oldestOverdueMs, now - t);
    }
  }

  void opts; // RLS handles member-vs-admin scoping at the row level

  return {
    callsToday: rowsToday.length,
    callsYesterday: rowsYest.length,
    connectRateToday:
      rowsToday.length === 0 ? 0 : connectedToday / rowsToday.length,
    connectRateYesterday:
      rowsYest.length === 0 ? 0 : connectedYest / rowsYest.length,
    appointmentsToday: apptsToday,
    appointmentsYesterday: apptsYest,
    costPerAppointmentToday: apptsToday === 0 ? 0 : spendToday / apptsToday,
    pendingCallbacks: cbRows.length,
    overdueCallbacks: overdueCount,
    oldestOverdueMinutes:
      oldestOverdueMs > 0 ? Math.floor(oldestOverdueMs / 60_000) : null,
  };
}

export async function fetchActionQueue(
  supabase: SupabaseClient,
  opts: { isAdmin: boolean; ownerId: string },
): Promise<ActionItem[]> {
  const items: ActionItem[] = [];
  const now = new Date();

  // 1. Overdue callbacks — highest urgency.
  type CbRow = {
    id: string;
    scheduled_at: string;
    lead: { id: string; company: string | null } | null;
  };
  const { data: overdueCb } = await supabase
    .from("callbacks")
    .select("id, scheduled_at, lead:leads(id, company)")
    .eq("status", "pending")
    .lt("scheduled_at", now.toISOString())
    .order("scheduled_at", { ascending: true })
    .limit(5);
  for (const row of (overdueCb ?? []) as unknown as CbRow[]) {
    const company = row.lead?.company ?? "lead";
    const ageMin = Math.floor(
      (now.getTime() - new Date(row.scheduled_at).getTime()) / 60_000,
    );
    items.push({
      id: `cb-${row.id}`,
      kind: "overdue_callback",
      message: `Call back ${company} (${ageMin}m overdue)`,
      href: row.lead?.id ? `/leads/${row.lead.id}` : "/callbacks",
      urgency: "high",
      at: row.scheduled_at,
    });
  }

  // 2. Goal-met leads still in 'goal_met' state — need an attended /
  //    no_show transition. Look back 7 days to surface stale ones.
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const { data: pendingGoals } = await supabase
    .from("leads")
    .select("id, company")
    .eq("status", "goal_met")
    .gte("updated_at", sevenDaysAgo)
    .is("deleted_at", null)
    .limit(5);
  for (const row of pendingGoals ?? []) {
    items.push({
      id: `goal-${row.id}`,
      kind: "needs_status_update",
      message: `${row.company ?? "Lead"} hit Goal Met — log attended or no_show`,
      href: `/leads/${row.id}`,
      urgency: "normal",
      at: now.toISOString(),
    });
  }

  // 3. Email replies — leads in 'email_replied' state.
  const { data: emailReplies } = await supabase
    .from("leads")
    .select("id, company")
    .eq("status", "email_replied")
    .is("deleted_at", null)
    .order("updated_at", { ascending: false })
    .limit(5);
  for (const row of emailReplies ?? []) {
    items.push({
      id: `email-${row.id}`,
      kind: "email_reply",
      message: `${row.company ?? "Lead"} replied via email`,
      href: `/leads/${row.id}`,
      urgency: "normal",
      at: now.toISOString(),
    });
  }

  // 4. Admin-only signals.
  if (opts.isAdmin) {
    // Campaigns auto-paused by spend cap or manual.
    const { data: pausedCampaigns } = await supabase
      .from("campaigns")
      .select("id, name, paused_reason")
      .eq("status", "paused")
      .not("paused_reason", "is", null)
      .limit(5);
    for (const row of pausedCampaigns ?? []) {
      const reason = (row as { paused_reason: string }).paused_reason;
      const isCap = reason && reason.includes("cap");
      items.push({
        id: `pause-${row.id}`,
        kind: "campaign_paused",
        message: `${row.name} is paused${isCap ? " (hit a budget cap)" : ""}`,
        href: "/campaigns",
        urgency: isCap ? "high" : "normal",
        at: now.toISOString(),
      });
    }

    // Flagged Twilio numbers.
    const { data: flaggedNums } = await supabase
      .from("twilio_numbers")
      .select("id, phone_number, friendly_name")
      .eq("flagged_for_rotation", true)
      .limit(3);
    for (const row of flaggedNums ?? []) {
      items.push({
        id: `num-${row.id}`,
        kind: "number_flagged",
        message: `Swap ${row.friendly_name ?? row.phone_number} — low connect rate`,
        href: "/settings/twilio-numbers",
        urgency: "high",
        at: now.toISOString(),
      });
    }
  }

  // High urgency first, then by age.
  items.sort((a, b) => {
    if (a.urgency !== b.urgency) return a.urgency === "high" ? -1 : 1;
    return a.at < b.at ? -1 : 1;
  });

  return items.slice(0, 8);
}

/** Hour-by-hour appointment trend for today's hero sparkline + a pace
 *  comparison: "by this time yesterday we had N appointments". */
export type AppointmentPace = {
  /** 24-bucket array — appointments booked in each hour today (0..23). */
  hourly: number[];
  /** Appointments yesterday up to the same wall-clock minute. */
  yesterdayByNow: number;
  /** Total appointments yesterday across the whole day (closing total). */
  yesterdayTotal: number;
};

export async function fetchAppointmentPace(
  supabase: SupabaseClient,
): Promise<AppointmentPace> {
  const now = new Date();
  const todayStartIso = startOfTodayEtIso(now);
  const yEt = etDateDaysAgo(1, now);
  const yStartIso = etDayRangeUtc(yEt).startUtc;
  const yEndIso = endOfEtDayUtcIso(yEt);
  // "By now yesterday" ≈ the instant 24h ago — tz-safe and good enough for a
  // pace comparison.
  const yesterdaySameInstant = now.getTime() - 24 * 60 * 60 * 1000;

  const [{ data: todayApps }, { data: yestApps }] = await Promise.all([
    supabase
      .from("calls")
      .select("created_at")
      .eq("goal_met", true)
      .gte("created_at", todayStartIso),
    supabase
      .from("calls")
      .select("created_at")
      .eq("goal_met", true)
      .gte("created_at", yStartIso)
      .lte("created_at", yEndIso),
  ]);

  // Bucket today's appointments by their Eastern hour (0..23).
  const hourly = new Array<number>(24).fill(0);
  for (const r of todayApps ?? []) {
    const h = etHour(new Date(r.created_at));
    if (h >= 0 && h < 24) hourly[h] += 1;
  }

  const yesterdayRows = yestApps ?? [];
  const yesterdayByNow = yesterdayRows.filter(
    (r) => new Date(r.created_at).getTime() <= yesterdaySameInstant,
  ).length;

  return {
    hourly,
    yesterdayByNow,
    yesterdayTotal: yesterdayRows.length,
  };
}

export type ActiveCall = {
  id: string;
  status: "queued" | "dialing" | "ringing" | "in_progress";
  started_at: string | null;
  duration_seconds: number | null;
  leadCompany: string | null;
  campaignName: string | null;
};

/** Calls currently in flight — anything not yet in a terminal state.
 *  In mock mode this is usually empty (the mock dialer inserts calls
 *  directly as status='completed'); in live mode this is the live view
 *  of what the AI is doing right now. */
export async function fetchActiveCalls(
  supabase: SupabaseClient,
  limit = 5,
): Promise<{ rows: ActiveCall[]; total: number }> {
  // Get the active rows + a separate exact count so the widget can show
  // "+N more" without pulling everything.
  const [{ data: rows }, { count }] = await Promise.all([
    supabase
      .from("calls")
      .select(
        "id, status, started_at, duration_seconds, lead:leads(company), campaign:campaigns(name)",
      )
      .in("status", ["queued", "dialing", "ringing", "in_progress"])
      .order("started_at", { ascending: false, nullsFirst: false })
      .limit(limit),
    supabase
      .from("calls")
      .select("id", { count: "exact", head: true })
      .in("status", ["queued", "dialing", "ringing", "in_progress"]),
  ]);
  type RawRow = {
    id: string;
    status: ActiveCall["status"];
    started_at: string | null;
    duration_seconds: number | null;
    lead: { company: string | null } | null;
    campaign: { name: string | null } | null;
  };
  const mapped: ActiveCall[] = ((rows ?? []) as unknown as RawRow[]).map(
    (r) => ({
      id: r.id,
      status: r.status,
      started_at: r.started_at,
      duration_seconds: r.duration_seconds,
      leadCompany: r.lead?.company ?? null,
      campaignName: r.campaign?.name ?? null,
    }),
  );
  return { rows: mapped, total: count ?? 0 };
}

export type AutopilotStatus = {
  /** Campaigns currently dialing. */
  activeCampaigns: number;
  /** Campaigns that exist but are paused. */
  pausedCampaigns: number;
};

/** Lightweight read of campaign run-state for the Autopilot strip. There
 *  is no single global on/off switch — the dialer runs per-campaign — so
 *  "running" is simply "at least one campaign is active". RLS scopes the
 *  counts to what the viewer is allowed to see. */
export async function fetchAutopilotStatus(
  supabase: SupabaseClient,
): Promise<AutopilotStatus> {
  const [{ count: active }, { count: paused }] = await Promise.all([
    supabase
      .from("campaigns")
      .select("id", { count: "exact", head: true })
      .eq("status", "active"),
    supabase
      .from("campaigns")
      .select("id", { count: "exact", head: true })
      .eq("status", "paused"),
  ]);
  return {
    activeCampaigns: active ?? 0,
    pausedCampaigns: paused ?? 0,
  };
}
