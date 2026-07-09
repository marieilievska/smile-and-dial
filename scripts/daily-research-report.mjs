// Daily Market Research call report. Writes a CSV of the PRIOR day's outbound
// calls (US Eastern day) to the user's Documents folder, one row per call with
// the lead's identity + outcome + research data-collection answers.
//
// Run manually:  node scripts/daily-research-report.mjs
//   --date=YYYY-MM-DD   report a specific ET day instead of yesterday
//   --out="C:\\path"     output folder (default: <USERPROFILE>\Documents)
//
// Intended to run every morning via Windows Task Scheduler. Reads Supabase
// creds from .env.local (never committed), so it must run on a machine that has
// that file — i.e. locally, not in the cloud.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const env = {};
for (const line of readFileSync(join(ROOT, ".env.local"), "utf8").split(
  /\r?\n/,
)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m) env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, "");
}
const SUPA = env.NEXT_PUBLIC_SUPABASE_URL;
const SKEY = env.SUPABASE_SERVICE_ROLE_KEY;
const sh = { apikey: SKEY, Authorization: `Bearer ${SKEY}` };

const CAMPAIGN = "Market Research";
const TZ = "America/New_York";
const CONNECTED = new Set([
  "goal_met",
  "callback",
  "call_back_later",
  "not_interested",
  "gatekeeper",
  "transferred_to_human",
  "language_barrier",
  "hung_up_immediately",
  "ai_error",
  "dnc",
]);

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.join("=")];
  }),
);

// The ET calendar date we're reporting on (default = yesterday).
const todayET = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(
  new Date(),
);
function addDays(ymd, n) {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
const day = /^\d{4}-\d{2}-\d{2}$/.test(args.date || "")
  ? args.date
  : addDays(todayET, -1);
const etDate = (iso) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(iso));

const norm = (v) => (v == null ? "" : ("" + v).trim());
const esc = (v) => `"${norm(v).replace(/"/g, '""')}"`;
const leadOf = (r) =>
  r.lead && typeof r.lead === "object"
    ? Array.isArray(r.lead)
      ? r.lead[0] || {}
      : r.lead
    : {};
const exOf = (r) =>
  r.extracted_data && typeof r.extracted_data === "object"
    ? r.extracted_data
    : {};

async function main() {
  // Resolve the campaign id by name.
  const camps = await (
    await fetch(
      `${SUPA}/rest/v1/campaigns?name=eq.${encodeURIComponent(CAMPAIGN)}&select=id`,
      { headers: sh },
    )
  ).json();
  const campaignId = camps?.[0]?.id;
  if (!campaignId) throw new Error(`Campaign "${CAMPAIGN}" not found`);

  // Pull this ET day's outbound calls. Query a generous UTC lower bound (the ET
  // day starts ~4–5h into UTC) then filter precisely by ET calendar date.
  const sinceUtc = `${day}T00:00:00Z`;
  const untilUtc = `${addDays(day, 1)}T12:00:00Z`;
  const rows = await (
    await fetch(
      `${SUPA}/rest/v1/calls?campaign_id=eq.${campaignId}&direction=eq.outbound` +
        `&started_at=gte.${sinceUtc}&started_at=lt.${untilUtc}` +
        `&select=started_at,outcome,duration_seconds,goal_met,extracted_data,lead:leads(company,owner_name,business_phone,business_email)` +
        `&order=started_at.asc&limit=5000`,
      { headers: sh },
    )
  ).json();
  const calls = (Array.isArray(rows) ? rows : []).filter(
    (r) => r.started_at && etDate(r.started_at) === day,
  );

  const header = [
    "company",
    "owner_name",
    "phone",
    "email",
    "call_time_ET",
    "outcome",
    "connected",
    "conversation_over_1min",
    "decision_maker_reached",
    "ai_call_answering_interest",
    "ai_call_answering_reason",
    "current_ai_tools",
    "disposition",
  ];
  const lines = [header.join(",")];
  for (const r of calls) {
    const L = leadOf(r);
    const x = exOf(r);
    lines.push(
      [
        L.company,
        L.owner_name,
        L.business_phone,
        L.business_email,
        new Date(r.started_at).toLocaleString("en-US", { timeZone: TZ }),
        r.outcome,
        CONNECTED.has(r.outcome) ? "yes" : "no",
        (r.duration_seconds || 0) > 60 ? "yes" : "no",
        norm(x.decision_maker_reached) === "yes" ? "yes" : "no",
        x.ai_call_answering_interest,
        x.ai_call_answering_reason,
        x.current_ai_tools,
        x.disposition,
      ]
        .map(esc)
        .join(","),
    );
  }

  const outDir = args.out || join(process.env.USERPROFILE || ROOT, "Documents");
  const outPath = join(outDir, `market-research-${day}.csv`);
  // BOM so Excel renders accents correctly.
  writeFileSync(outPath, "﻿" + lines.join("\r\n"), "utf8");

  const connected = calls.filter((r) => CONNECTED.has(r.outcome)).length;
  const convo = calls.filter((r) => (r.duration_seconds || 0) > 60).length;
  const dms = calls.filter(
    (r) => norm(exOf(r).decision_maker_reached) === "yes",
  ).length;
  const goals = calls.filter(
    (r) => r.outcome === "goal_met" || r.goal_met === true,
  ).length;
  const interest = {};
  for (const r of calls) {
    const v = norm(exOf(r).ai_call_answering_interest).toLowerCase();
    if (["yes", "no", "maybe"].includes(v))
      interest[v] = (interest[v] || 0) + 1;
  }
  console.log(`Daily Market Research report for ${day} (ET)`);
  console.log(`Saved: ${outPath}`);
  console.log(
    `Calls ${calls.length} | connected ${connected} | conversations>1min ${convo} | DMs ${dms} | goals ${goals}`,
  );
  console.log(`Interest: ${JSON.stringify(interest)}`);
}

main().catch((e) => {
  console.error("daily-research-report failed:", e.message);
  process.exit(1);
});
