import type { SupabaseClient } from "@supabase/supabase-js";

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

const CONVERSATION_OUTCOMES = new Set([
  "goal_met",
  "not_interested",
  "callback",
  "dnc",
  "transferred_to_human",
  "gatekeeper",
  "language_barrier",
]);
const CONNECTED_OUTCOMES = new Set([
  ...CONVERSATION_OUTCOMES,
  "voicemail",
  "hung_up_immediately",
  "ai_receptionist",
  "ai_error",
]);

function todayStart(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function yesterdayWindow(): { from: string; to: string } {
  const start = todayStart();
  const yEnd = new Date(start);
  yEnd.setMilliseconds(-1);
  const yStart = new Date(start);
  yStart.setDate(yStart.getDate() - 1);
  return { from: yStart.toISOString(), to: yEnd.toISOString() };
}

function pickTotal(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  const t = (value as { total?: unknown }).total;
  return typeof t === "number" && Number.isFinite(t) ? t : 0;
}

export async function fetchHeroCounts(
  supabase: SupabaseClient,
  opts: { isAdmin: boolean; ownerId: string },
): Promise<HeroCounts> {
  const start = todayStart();
  const yWindow = yesterdayWindow();

  // Today's calls — RLS scopes for members; admins see everything.
  const callsTodayQuery = supabase
    .from("calls")
    .select("id, outcome, goal_met, cost_breakdown")
    .gte("created_at", start.toISOString());
  const callsYestQuery = supabase
    .from("calls")
    .select("id, outcome, goal_met")
    .gte("created_at", yWindow.from)
    .lte("created_at", yWindow.to);

  const callbacksQuery = supabase
    .from("callbacks")
    .select("id, scheduled_at")
    .eq("status", "pending");

  const [{ data: callsToday }, { data: callsYest }, { data: callbacks }] =
    await Promise.all([callsTodayQuery, callsYestQuery, callbacksQuery]);

  const rowsToday = callsToday ?? [];
  const rowsYest = callsYest ?? [];

  const apptsToday = rowsToday.filter((r) => r.goal_met).length;
  const apptsYest = rowsYest.filter((r) => r.goal_met).length;

  const connectedToday = rowsToday.filter(
    (r) => r.outcome && CONNECTED_OUTCOMES.has(r.outcome),
  ).length;
  const connectedYest = rowsYest.filter(
    (r) => r.outcome && CONNECTED_OUTCOMES.has(r.outcome),
  ).length;

  const spendToday = rowsToday.reduce(
    (sum, r) => sum + pickTotal(r.cost_breakdown),
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
      href: row.lead?.id ? `/leads?lead=${row.lead.id}` : "/callbacks",
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
      href: `/leads?lead=${row.id}`,
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
      href: `/leads?lead=${row.id}`,
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

/** Daily call counts for the last 7 days. */
export async function fetch7dCallTrend(
  supabase: SupabaseClient,
): Promise<{ day: string; count: number }[]> {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - 6);
  const { data: rows } = await supabase
    .from("calls")
    .select("created_at")
    .gte("created_at", start.toISOString())
    .order("created_at", { ascending: true });

  const buckets = new Map<string, number>();
  for (
    let d = new Date(start);
    d.getTime() <= Date.now();
    d.setDate(d.getDate() + 1)
  ) {
    buckets.set(d.toISOString().slice(0, 10), 0);
  }
  for (const r of rows ?? []) {
    const day = r.created_at.slice(0, 10);
    buckets.set(day, (buckets.get(day) ?? 0) + 1);
  }
  return [...buckets.entries()].map(([day, count]) => ({ day, count }));
}
