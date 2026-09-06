// Prove the analytics_summary SQL agrees with the JavaScript it replaced.
//
//   node --env-file=.env.local scripts/verify-analytics-parity.mjs
//
// /analytics used to page every call in the window out of the database and
// count it in a for-loop. It now calls one aggregate, `analytics_summary`
// (migrations 20260906080000 / 081000). Two implementations of the same
// counting rules is exactly the situation where the two quietly drift apart,
// so this runs BOTH over the same production windows and diffs every number:
// each KPI component, the outcome distribution, the per-Eastern-day series,
// the per-campaign ranking, and the folded funnel.
//
// The JavaScript side re-implements what src/lib/analytics/stats.ts does,
// deliberately standalone — it fetches its own rows so the check does not
// depend on the app's data layer being correct.
//
// READ ONLY. It never writes anything.
//
// Exit code 0 = identical, 1 = a difference (or a failed query).

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.",
  );
  process.exit(1);
}
const sb = createClient(url, serviceKey);

// Mirrors of the app's constants. If one of these drifts from
// src/lib/calls/outcomes.ts the unit test catches it; this script only needs
// them to reproduce the old arithmetic.
const CONNECTED = new Set([
  "goal_met",
  "callback",
  "call_back_later",
  "not_interested",
  "gatekeeper",
  "gatekeeper_not_interested",
  "transferred_to_human",
  "language_barrier",
  "hung_up_immediately",
  "hung_up_later",
  "dnc",
]);
const CONVERSATION = new Set([
  "goal_met",
  "callback",
  "not_interested",
  "gatekeeper",
  "gatekeeper_not_interested",
  "transferred_to_human",
  "language_barrier",
]);
const COST_KEYS = ["twilio", "elevenlabs", "openai", "openai_review", "lookup"];

const numField = (v, k) =>
  v &&
  typeof v === "object" &&
  typeof v[k] === "number" &&
  Number.isFinite(v[k])
    ? v[k]
    : 0;
const breakdownTotal = (v) => {
  let s = 0;
  for (const k of COST_KEYS) s += numField(v, k);
  return s > 0 ? s : numField(v, "total");
};
const etDay = (d) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
const money = (n) => Number(Number(n).toFixed(4));

/** Eastern day bounds as UTC instants, matching lib/time/eastern. */
function etBounds(fromDay, toDay) {
  const at = (day, endOfDay) => {
    const probe = new Date(`${day}T12:00:00Z`);
    const offset =
      /GMT([+-]\d+)/.exec(
        new Intl.DateTimeFormat("en-US", {
          timeZone: "America/New_York",
          timeZoneName: "shortOffset",
        }).format(probe),
      )?.[1] ?? "-5";
    const hours = -Number(offset);
    const base = new Date(`${day}T00:00:00Z`);
    base.setUTCHours(base.getUTCHours() + hours);
    if (endOfDay)
      base.setUTCMilliseconds(base.getUTCMilliseconds() + 86_400_000 - 1);
    return base.toISOString();
  };
  return { start: at(fromDay, false), end: at(toDay, true) };
}

/** The OLD path: page every call, join the lead DM flag, aggregate in JS. */
async function aggregateInJs(start, end) {
  const PAGE = 1000;
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await sb
      .from("calls")
      .select(
        "campaign_id, lead_id, outcome, goal_met, duration_seconds, talk_time_seconds, cost_breakdown, created_at",
      )
      .gte("created_at", start)
      .lte("created_at", end)
      .order("created_at", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`calls page failed: ${error.message}`);
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }

  const leadIds = [...new Set(rows.map((r) => r.lead_id))];
  const dm = new Map();
  for (let i = 0; i < leadIds.length; i += 200) {
    const { data, error } = await sb
      .from("leads")
      .select("id, decision_maker_reached")
      .in("id", leadIds.slice(i, i + 200));
    if (error) throw new Error(`lead lookup failed: ${error.message}`);
    for (const l of data ?? []) dm.set(l.id, l.decision_maker_reached === true);
  }

  const called = new Set(),
    connRaw = new Set(),
    convRaw = new Set();
  const dmRaw = new Set(),
    goalRaw = new Set(),
    goalDm = new Set();
  const outcomes = new Map(),
    byDay = new Map(),
    byCampaign = new Map();
  let connected = 0,
    aiError = 0,
    conversations = 0,
    dmsReached = 0;
  let durationSum = 0,
    durationCount = 0,
    spend = 0,
    callbacks = 0,
    dnc = 0;

  for (const r of rows) {
    const isDm = dm.get(r.lead_id) === true;
    const isConn = !!r.outcome && CONNECTED.has(r.outcome);
    const cost = breakdownTotal(r.cost_breakdown);

    called.add(r.lead_id);
    if (isConn) {
      connRaw.add(r.lead_id);
      connected += 1;
    }
    const talk = r.talk_time_seconds ?? r.duration_seconds ?? 0;
    if (isConn && talk >= 60) convRaw.add(r.lead_id);
    if (isDm) {
      dmRaw.add(r.lead_id);
      dmsReached += 1;
    }
    if (r.goal_met) {
      goalRaw.add(r.lead_id);
      if (isDm) goalDm.add(r.lead_id);
    }
    if (r.outcome === "ai_error") aiError += 1;
    if (r.outcome && CONVERSATION.has(r.outcome)) conversations += 1;
    if (r.outcome === "callback") callbacks += 1;
    if (r.outcome === "dnc") dnc += 1;
    if (r.duration_seconds != null) {
      durationSum += r.duration_seconds;
      durationCount += 1;
    }
    spend += cost;

    const key = r.outcome ?? "no_outcome";
    outcomes.set(key, (outcomes.get(key) ?? 0) + 1);

    const day = etDay(new Date(r.created_at));
    const b = byDay.get(day) ?? { calls: 0, spend: 0, goal: new Set() };
    b.calls += 1;
    b.spend += cost;
    if (r.goal_met) b.goal.add(r.lead_id);
    byDay.set(day, b);

    const cv = byCampaign.get(r.campaign_id) ?? { goal: new Set(), spend: 0 };
    if (r.goal_met) cv.goal.add(r.lead_id);
    cv.spend += cost;
    byCampaign.set(r.campaign_id, cv);
  }

  // The fold, exactly as buildLeadFunnel does it.
  const foldedDm = dmRaw;
  const foldedConv = new Set([...convRaw, ...goalRaw, ...foldedDm]);
  const foldedConn = new Set([...connRaw, ...foldedConv]);

  return {
    pagedRows: rows.length,
    totals: {
      total_calls: rows.length,
      connected,
      ai_error: aiError,
      conversations,
      dms_reached: dmsReached,
      callbacks,
      dnc_additions: dnc,
      duration_sum: durationSum,
      duration_count: durationCount,
      spend,
      lead_goal: goalRaw.size,
      lead_goal_dm: goalDm.size,
      funnel_called: called.size,
      funnel_connected: foldedConn.size,
      funnel_conversation: foldedConv.size,
      funnel_dm: foldedDm.size,
    },
    outcomes: [...outcomes.entries()]
      .map(([outcome, count]) => ({ outcome, count }))
      .sort((a, b) => b.count - a.count || a.outcome.localeCompare(b.outcome)),
    byDay: [...byDay.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([day, v]) => ({
        day,
        calls: v.calls,
        spend: money(v.spend),
        goalLeads: v.goal.size,
      })),
    byCampaign: [...byCampaign.entries()]
      .map(([campaignId, v]) => ({
        campaignId,
        goalMet: v.goal.size,
        spend: money(v.spend),
      }))
      .sort((a, b) => b.goalMet - a.goalMet),
  };
}

// Windows worth checking: the page's default, one busy single day, a range
// with no calls in it, and a wide one that spans months.
const today = etDay(new Date());
const daysAgo = (n) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return etDay(d);
};
const WINDOWS = [
  ["default 30 days", daysAgo(29), today],
  ["last 7 days", daysAgo(6), today],
  ["single day", daysAgo(3), daysAgo(3)],
  ["a year", daysAgo(364), today],
  ["empty (future)", daysAgo(-30), daysAgo(-25)],
];

let failures = 0;

for (const [label, fromDay, toDay] of WINDOWS) {
  const { start, end } = etBounds(fromDay, toDay);

  const js = await aggregateInJs(start, end);

  const t0 = Date.now();
  const { data: sqlOut, error } = await sb.rpc("analytics_summary", {
    p_start: start,
    p_end: end,
    p_campaign: null,
    p_owner: null,
    p_list: null,
  });
  const rpcMs = Date.now() - t0;
  if (error) {
    console.error(`  analytics_summary failed: ${error.message}`);
    failures += 1;
    continue;
  }

  const diffs = [];
  const cmp = (name, a, b) => {
    if (a !== b) diffs.push(`${name}: js=${a} sql=${b}`);
  };

  for (const k of Object.keys(js.totals)) {
    const a = js.totals[k],
      b = sqlOut.totals[k];
    cmp(
      k,
      typeof a === "number" && !Number.isInteger(a) ? money(a) : a,
      typeof b === "string"
        ? money(b)
        : typeof b === "number" && !Number.isInteger(b)
          ? money(b)
          : b,
    );
  }
  cmp(
    "outcomes",
    JSON.stringify(js.outcomes),
    JSON.stringify(
      sqlOut.outcomes.map((o) => ({ outcome: o.outcome, count: o.count })),
    ),
  );
  cmp(
    "byDay",
    JSON.stringify(js.byDay),
    JSON.stringify(
      sqlOut.byDay.map((d) => ({
        day: d.day,
        calls: d.calls,
        spend: money(d.spend),
        goalLeads: d.goalLeads,
      })),
    ),
  );
  cmp(
    "byCampaign",
    JSON.stringify(js.byCampaign),
    JSON.stringify(
      sqlOut.byCampaign.map((c) => ({
        campaignId: c.campaignId,
        goalMet: c.goalMet,
        spend: money(c.spend),
      })),
    ),
  );

  // The funnel must narrow. A step rate over 100% is the bug the fold exists
  // to prevent, so assert the shape as well as the parity.
  const f = sqlOut.totals;
  if (
    !(
      f.funnel_called >= f.funnel_connected &&
      f.funnel_connected >= f.funnel_conversation &&
      f.funnel_conversation >= f.funnel_dm
    )
  ) {
    diffs.push(
      `funnel does not narrow: ${f.funnel_called}/${f.funnel_connected}/${f.funnel_conversation}/${f.funnel_dm}`,
    );
  }

  const ok = diffs.length === 0;
  if (!ok) failures += diffs.length;
  console.log(
    `${ok ? "OK  " : "FAIL"}  ${label.padEnd(16)} ${String(js.pagedRows).padStart(6)} calls paged by JS   RPC ${String(rpcMs).padStart(5)}ms   funnel ${f.funnel_called}/${f.funnel_connected}/${f.funnel_conversation}/${f.funnel_dm}`,
  );
  for (const d of diffs) console.log(`        ${d}`);
}

if (failures === 0) {
  console.log(
    "\nEvery window identical. The SQL agrees with the JavaScript it replaced.",
  );
  process.exit(0);
}
console.error(
  `\n${failures} difference(s). analytics_summary and stats.ts disagree.`,
);
process.exit(1);
