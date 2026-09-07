// Prove the reporting_daily_kpis SQL agrees with the JavaScript it replaced.
//
//   node --env-file=.env.local scripts/verify-reporting-parity.mjs
//
// The Reporting dashboard used to page the last 30 Eastern days of calls out of
// the database — nine 233 KB requests, end to end — and group them per day in a
// for-loop. It now calls one aggregate, `reporting_daily_kpis` (migration
// 20260907090000). Two implementations of the same counting rules is where they
// quietly drift, so this runs BOTH over the same production windows and diffs
// every counter on every day, plus the per-day sentiment buckets.
//
// The JavaScript side re-implements computeDailyKpis standalone and fetches its
// own rows, so the check does not depend on the app's data layer being right.
//
// READ ONLY. Exit 0 = identical, 1 = a difference.

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
const EXCLUDES_DM = new Set([
  "gatekeeper",
  "gatekeeper_not_interested",
  "voicemail",
  "no_answer",
  "busy",
  "failed",
  "invalid_number",
  "ai_receptionist",
  "ai_error",
  "hung_up_immediately",
  "hung_up_later",
]);

const etDay = (iso) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(
    new Date(iso),
  );

/** callReachedDm, verbatim. */
function dmReached(row) {
  if (row.outcome != null && EXCLUDES_DM.has(row.outcome)) return false;
  const ed =
    row.extracted_data && typeof row.extracted_data === "object"
      ? row.extracted_data
      : {};
  const v = ed.decision_maker_reached;
  return typeof v === "string" && v.trim().toLowerCase() === "yes";
}

/** The OLD path: page every call, group per Eastern day in JS. */
async function aggregateInJs(since, campaignIds, sentimentKey) {
  const PAGE = 1000;
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    let q = sb
      .from("calls")
      .select("created_at, outcome, duration_seconds, extracted_data, lead_id")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .range(offset, offset + PAGE - 1);
    if (campaignIds) q = q.in("campaign_id", campaignIds);
    const { data, error } = await q;
    if (error) throw new Error(`calls page failed: ${error.message}`);
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }

  const byDay = new Map();
  const goalLeadsByDay = new Map();
  for (const r of rows) {
    if (!r.created_at) continue;
    const day = etDay(r.created_at);
    let k = byDay.get(day);
    if (!k) {
      k = {
        day,
        callsMade: 0,
        connected: 0,
        convGt1min: 0,
        dms: 0,
        callbacks: 0,
        goals: 0,
        notInterested: 0,
        gatekeeper: 0,
        gatekeeperDeclined: 0,
        hungUp: 0,
        hungUpLater: 0,
        aiError: 0,
        dnc: 0,
        sentimentCounts: {},
      };
      byDay.set(day, k);
    }
    k.callsMade++;
    const o = r.outcome ?? "";
    const connected = CONNECTED.has(o);
    if (connected) k.connected++;
    if (connected && (r.duration_seconds ?? 0) > 60) k.convGt1min++;
    if (dmReached(r)) k.dms++;
    if (o === "callback") k.callbacks++;
    if (o === "goal_met" && r.lead_id) {
      let s = goalLeadsByDay.get(day);
      if (!s) {
        s = new Set();
        goalLeadsByDay.set(day, s);
      }
      s.add(r.lead_id);
    }
    if (o === "not_interested") k.notInterested++;
    if (o === "gatekeeper") k.gatekeeper++;
    if (o === "gatekeeper_not_interested") k.gatekeeperDeclined++;
    if (o === "hung_up_immediately") k.hungUp++;
    if (o === "hung_up_later") k.hungUpLater++;
    if (o === "ai_error") k.aiError++;
    if (o === "dnc") k.dnc++;
    if (sentimentKey) {
      const ed =
        r.extracted_data && typeof r.extracted_data === "object"
          ? r.extracted_data
          : {};
      const v = String(ed[sentimentKey] ?? "")
        .trim()
        .toLowerCase();
      if (v) k.sentimentCounts[v] = (k.sentimentCounts[v] ?? 0) + 1;
    }
  }
  for (const k of byDay.values()) {
    k.goals = goalLeadsByDay.get(k.day)?.size ?? 0;
  }
  return {
    pagedRows: rows.length,
    days: [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1)),
  };
}

/** ET midnight `days` ago, as a UTC instant — matches sinceDaysAgoIso. */
function sinceDaysAgoIso(days) {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
  }).format(new Date());
  const [y, m, d] = today.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() - days);
  const day = t.toISOString().slice(0, 10);
  const probe = new Date(`${day}T12:00:00Z`);
  const offset =
    /GMT([+-]\d+)/.exec(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        timeZoneName: "shortOffset",
      }).format(probe),
    )?.[1] ?? "-5";
  const base = new Date(`${day}T00:00:00Z`);
  base.setUTCHours(base.getUTCHours() - Number(offset));
  return base.toISOString();
}

// Which campaigns exist, so one window can be scoped to a real campaign.
const { data: camps } = await sb.from("campaigns").select("id").limit(1);
const oneCampaign = camps?.[0]?.id ? [camps[0].id] : null;

const WINDOWS = [
  ["30 days, all", sinceDaysAgoIso(30), null, null],
  ["7 days, all", sinceDaysAgoIso(7), null, null],
  ["90 days, all", sinceDaysAgoIso(90), null, null],
  ["30 days, 1 campaign", sinceDaysAgoIso(30), oneCampaign, null],
  // No CUSTOM extracted_data fields exist in this workspace, so a real
  // sentiment key would test nothing. `disposition` is a standard key with five
  // well-populated values — the RPC reads whatever key it is given, so this
  // exercises the dynamic bucketing for real.
  ["30 days + sentiment", sinceDaysAgoIso(30), null, "disposition"],
  ["30 days + dm bucket", sinceDaysAgoIso(30), null, "decision_maker_reached"],
  ["future (empty)", sinceDaysAgoIso(-30), null, null],
];

const COUNTERS = [
  "callsMade",
  "connected",
  "convGt1min",
  "dms",
  "callbacks",
  "goals",
  "notInterested",
  "gatekeeper",
  "gatekeeperDeclined",
  "hungUp",
  "hungUpLater",
  "aiError",
  "dnc",
];

let failures = 0;

for (const [label, since, campaignIds, sentimentKey] of WINDOWS) {
  if (campaignIds === null && label.includes("campaign")) {
    console.log(`SKIP  ${label} — no campaigns in this workspace`);
    continue;
  }
  const js = await aggregateInJs(since, campaignIds, sentimentKey);

  const t0 = Date.now();
  const { data: sql, error } = await sb.rpc("reporting_daily_kpis", {
    p_since: since,
    p_campaign_ids: campaignIds,
    p_sentiment_key: sentimentKey,
  });
  const rpcMs = Date.now() - t0;
  if (error) {
    console.error(`  reporting_daily_kpis failed: ${error.message}`);
    failures += 1;
    continue;
  }

  const diffs = [];
  if (js.days.length !== sql.length) {
    diffs.push(`day count: js=${js.days.length} sql=${sql.length}`);
  }
  const sqlByDay = new Map(sql.map((d) => [d.day, d]));
  for (const [i, jd] of js.days.entries()) {
    const sd = sqlByDay.get(jd.day);
    if (!sd) {
      diffs.push(`missing day ${jd.day}`);
      continue;
    }
    if (sql[i]?.day !== jd.day) {
      diffs.push(`order at ${i}: js=${jd.day} sql=${sql[i]?.day}`);
    }
    for (const c of COUNTERS) {
      if (jd[c] !== sd[c])
        diffs.push(`${jd.day} ${c}: js=${jd[c]} sql=${sd[c]}`);
    }
    const a = JSON.stringify(Object.entries(jd.sentimentCounts).sort());
    const b = JSON.stringify(Object.entries(sd.sentimentCounts ?? {}).sort());
    if (a !== b) diffs.push(`${jd.day} sentimentCounts: js=${a} sql=${b}`);
  }

  const ok = diffs.length === 0;
  if (!ok) failures += diffs.length;
  console.log(
    `${ok ? "OK  " : "FAIL"}  ${label.padEnd(21)} ${String(js.pagedRows).padStart(6)} calls paged by JS   ${String(js.days.length).padStart(3)} days   RPC ${String(rpcMs).padStart(5)}ms`,
  );
  for (const d of diffs.slice(0, 12)) console.log(`        ${d}`);
  if (diffs.length > 12) console.log(`        …and ${diffs.length - 12} more`);
}

if (failures === 0) {
  console.log(
    "\nEvery window identical. The SQL agrees with the JavaScript it replaced.",
  );
  process.exit(0);
}
console.error(
  `\n${failures} difference(s). reporting_daily_kpis and stats.ts disagree.`,
);
process.exit(1);
