// Prove the cause_of_death_summary SQL agrees with the JavaScript it replaced.
//
//   node --experimental-strip-types --env-file=.env.local \
//     scripts/verify-cause-of-death-parity.mjs
//   (or: npm run verify:cause-of-death)
//
// The Cause of Death tab used to page every call in the window, chunk-load all
// ~7,500 of those leads, and classify each in JavaScript. It now calls one
// aggregate, `cause_of_death_summary` (migration 20260907100000), which does the
// classification in SQL.
//
// That is a bigger claim than the other three rewrites: assignCause() is an
// ORDERED rule chain where the first match wins, so a branch in the wrong place
// silently relabels leads rather than erroring. This script therefore imports
// the REAL assignCause and noContactReason from
// src/lib/agent-analytics/cause-of-death.ts (via --experimental-strip-types)
// instead of re-implementing them — re-transcribing the rules here would risk
// making the same misreading twice and calling it agreement.
//
// Compares, per window: the worked-lead total, all eight cause counts, the three
// group totals, every no-contact sub-reason count, the capped company samples
// (exact, including order), and the objection row counts.
//
// READ ONLY. Exit 0 = identical, 1 = a difference.

import { createClient } from "@supabase/supabase-js";

import {
  assignCause,
  noContactReason,
  CAUSE_GROUP,
} from "../src/lib/agent-analytics/cause-of-death.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.",
  );
  process.exit(1);
}
const sb = createClient(url, serviceKey);

const SAMPLE = 100;

/** The OLD path: page calls → per-lead facts → chunk-load leads → classify. */
async function classifyInJs(since, campaignIds) {
  const PAGE = 1000;
  const byLead = new Map();
  for (let offset = 0; ; offset += PAGE) {
    let q = sb
      .from("calls")
      .select(
        "lead_id, outcome, goal_met, created_at, objection_category, objection_specific, objection_quote",
      )
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .range(offset, offset + PAGE - 1);
    if (campaignIds) q = q.in("campaign_id", campaignIds);
    const { data, error } = await q;
    if (error) throw new Error(`calls page failed: ${error.message}`);
    const batch = data ?? [];
    for (const row of batch) {
      if (!row.lead_id) continue;
      const e = byLead.get(row.lead_id) ?? {
        outcomes: [],
        goalMet: false,
        objection: null,
        lastCallAt: null,
      };
      if (row.outcome) e.outcomes.push(row.outcome);
      if (row.goal_met) e.goalMet = true;
      if (!e.objection && row.objection_category) {
        e.objection = { category: row.objection_category };
      }
      if (!e.lastCallAt || row.created_at > e.lastCallAt) {
        e.lastCallAt = row.created_at;
      }
      byLead.set(row.lead_id, e);
    }
    if (batch.length < PAGE) break;
  }

  const leadIds = [...byLead.keys()];
  const meta = new Map();
  for (let i = 0; i < leadIds.length; i += 200) {
    const { data, error } = await sb
      .from("leads")
      .select("id, status, decision_maker_reached, company")
      .in("id", leadIds.slice(i, i + 200));
    if (error) throw new Error(`lead lookup failed: ${error.message}`);
    for (const l of data ?? []) {
      meta.set(l.id, {
        status: l.status ?? "",
        dm: l.decision_maker_reached === true,
        company: l.company ?? "",
      });
    }
  }

  const counts = {};
  const groups = { won: 0, final: 0, in_play: 0 };
  const noContact = {};
  const perCause = new Map(); // cause -> [{company, lastCallAt, leadId}]
  const perReason = new Map();
  const objections = {};
  let total = 0;

  for (const [leadId, agg] of byLead) {
    const m = meta.get(leadId);
    if (!m) continue; // lead deleted since the call — the app skipped these too
    total += 1;
    // THE REAL CLASSIFIER, imported — not a copy.
    const cause = assignCause({
      leadId,
      status: m.status,
      decisionMakerReached: m.dm,
      goalMet: agg.goalMet,
      outcomes: agg.outcomes,
    });
    counts[cause] = (counts[cause] ?? 0) + 1;
    groups[CAUSE_GROUP[cause]] += 1;
    const entry = { company: m.company, lastCallAt: agg.lastCallAt, leadId };
    if (!perCause.has(cause)) perCause.set(cause, []);
    perCause.get(cause).push(entry);

    if (cause === "no_contact") {
      const r = noContactReason(agg.outcomes);
      if (r) {
        noContact[r] = (noContact[r] ?? 0) + 1;
        if (!perReason.has(r)) perReason.set(r, []);
        perReason.get(r).push(entry);
      }
    }
    if ((cause === "dm_said_no" || cause === "gatekeeper") && agg.objection) {
      objections[cause] = (objections[cause] ?? 0) + 1;
    }
  }

  // Same ordering the SQL uses: most recently called first, then company, then id.
  const sampleOf = (list) =>
    [...list]
      .sort(
        (a, b) =>
          (a.lastCallAt < b.lastCallAt
            ? 1
            : a.lastCallAt > b.lastCallAt
              ? -1
              : 0) ||
          (a.company < b.company ? -1 : a.company > b.company ? 1 : 0) ||
          (a.leadId < b.leadId ? -1 : 1),
      )
      .slice(0, SAMPLE)
      .map((e) => e.company);

  return {
    workedLeads: byLead.size,
    total,
    counts,
    groups,
    noContact,
    objections,
    causeSamples: Object.fromEntries(
      [...perCause].map(([c, list]) => [c, sampleOf(list)]),
    ),
    reasonSamples: Object.fromEntries(
      [...perReason].map(([r, list]) => [r, sampleOf(list)]),
    ),
  };
}

function sinceDaysAgoIso(days) {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
  }).format(new Date());
  const [y, m, d] = today.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() - days);
  const day = t.toISOString().slice(0, 10);
  const offset =
    /GMT([+-]\d+)/.exec(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        timeZoneName: "shortOffset",
      }).format(new Date(`${day}T12:00:00Z`)),
    )?.[1] ?? "-5";
  const base = new Date(`${day}T00:00:00Z`);
  base.setUTCHours(base.getUTCHours() - Number(offset));
  return base.toISOString();
}

const { data: camps } = await sb.from("campaigns").select("id").limit(1);
const oneCampaign = camps?.[0]?.id ? [camps[0].id] : null;

const WINDOWS = [
  ["30 days, all", sinceDaysAgoIso(30), null],
  ["7 days, all", sinceDaysAgoIso(7), null],
  ["90 days, all", sinceDaysAgoIso(90), null],
  ["1 day", sinceDaysAgoIso(1), null],
  ["30 days, 1 campaign", sinceDaysAgoIso(30), oneCampaign],
  ["future (empty)", sinceDaysAgoIso(-30), null],
];

const ALL_CAUSES = [
  "won",
  "opted_out",
  "dm_said_no",
  "callback_booked",
  "mid_follow_up",
  "gatekeeper",
  "bad_number",
  "no_contact",
];
const ALL_REASONS = ["brushed_off", "machine", "no_pickup", "error"];

let failures = 0;

for (const [label, since, campaignIds] of WINDOWS) {
  const js = await classifyInJs(since, campaignIds);

  const t0 = Date.now();
  const { data: sql, error } = await sb.rpc("cause_of_death_summary", {
    p_since: since,
    ...(campaignIds ? { p_campaign_ids: campaignIds } : {}),
    p_sample: SAMPLE,
  });
  const rpcMs = Date.now() - t0;
  if (error) {
    console.error(`  cause_of_death_summary failed: ${error.message}`);
    failures += 1;
    continue;
  }

  const diffs = [];
  const cmp = (name, a, b) => {
    if (a !== b) diffs.push(`${name}: js=${a} sql=${b}`);
  };

  cmp("total", js.total, sql.total);
  for (const c of ALL_CAUSES) {
    cmp(`count.${c}`, js.counts[c] ?? 0, sql.causes?.[c]?.count ?? 0);
  }
  for (const g of ["won", "final", "in_play"]) {
    // The SQL returns causes, not groups — derive the group totals from them
    // the same way computeCauseOfDeath does.
    const fromSql = ALL_CAUSES.filter((c) => CAUSE_GROUP[c] === g).reduce(
      (s, c) => s + (sql.causes?.[c]?.count ?? 0),
      0,
    );
    cmp(`group.${g}`, js.groups[g], fromSql);
  }
  for (const r of ALL_REASONS) {
    cmp(`noContact.${r}`, js.noContact[r] ?? 0, sql.noContact?.[r]?.count ?? 0);
  }
  for (const c of ["dm_said_no", "gatekeeper"]) {
    cmp(
      `objections.${c}`,
      js.objections[c] ?? 0,
      (sql.objections?.[c] ?? []).length,
    );
  }
  // Sampled company lists, exact, including order.
  for (const c of ALL_CAUSES) {
    const a = JSON.stringify(js.causeSamples[c] ?? []);
    const b = JSON.stringify(sql.causes?.[c]?.sample ?? []);
    if (a !== b)
      diffs.push(
        `sample.${c} differs (js ${(js.causeSamples[c] ?? []).length} vs sql ${(sql.causes?.[c]?.sample ?? []).length})`,
      );
  }
  for (const r of ALL_REASONS) {
    const a = JSON.stringify(js.reasonSamples[r] ?? []);
    const b = JSON.stringify(sql.noContact?.[r]?.sample ?? []);
    if (a !== b) diffs.push(`sample.noContact.${r} differs`);
  }

  const ok = diffs.length === 0;
  if (!ok) failures += diffs.length;
  const shape = ALL_CAUSES.map((c) => sql.causes?.[c]?.count ?? 0).join("/");
  console.log(
    `${ok ? "OK  " : "FAIL"}  ${label.padEnd(21)} ${String(js.workedLeads).padStart(6)} worked leads   RPC ${String(rpcMs).padStart(5)}ms   ${shape}`,
  );
  for (const d of diffs.slice(0, 10)) console.log(`        ${d}`);
  if (diffs.length > 10) console.log(`        …and ${diffs.length - 10} more`);
}

console.log("\ncause order: " + ALL_CAUSES.join(" / "));
if (failures === 0) {
  console.log(
    "Every window identical. The SQL agrees with the real assignCause().",
  );
  process.exit(0);
}
console.error(
  `\n${failures} difference(s). cause_of_death_summary and cause-of-death.ts disagree.`,
);
process.exit(1);
