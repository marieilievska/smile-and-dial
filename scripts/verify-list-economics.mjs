// Prove the "Where the money goes" panel is rendering true numbers.
//
//   node --env-file=.env.local scripts/verify-list-economics.mjs
//   (or: npm run verify:list-economics)
//
// The panel divides real spend into a seven-step chain and projects a cost per
// attendee through the show rate. Two things can make it lie, and neither one
// looks wrong on screen:
//
//   1. A show rate above 100%. `attended` counts attended_at is not null with
//      no cancellation guard, while `regs` excludes cancelled rows, so a
//      registration marked attended and then cancelled sits in one and not the
//      other. list-economics.ts clamps settled to regs for exactly this; this
//      script checks whether the clamp has ever had to fire, because if it has,
//      the underlying data has drifted and somebody should know.
//
//   2. The Cohorts tab and /analytics computing DIFFERENT show rates. Both
//      derive attended / (attended + no_show) from calendly_events, from
//      predicates copied verbatim between two SQL functions. Copied predicates
//      drift. If these two disagree, one of the two pages is lying about the
//      same registrations and there is no way to tell which by looking.
//
// READ ONLY. It never writes anything.
//
// Exit code 0 = every check passed, 1 = a violation (or a failed query).

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

/** The cohort window to compare against. Wide enough to cover every dial day
 *  this workspace has, so the two totals are over the same registrations. */
const COHORT_START = "2026-01-01";
const COHORT_END = "2026-12-31";

const n = (v) => {
  const x = typeof v === "string" ? Number(v) : (v ?? 0);
  return Number.isFinite(x) ? x : 0;
};
const money = (v) => (v === null ? "—" : `$${v.toFixed(2)}`);
const pct = (v) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);

/** Mirrors lib/cohorts/math.ts `costPer`: null rather than Infinity, and null
 *  for zero SPEND too — no cost rows landed does not mean the calls were
 *  free, and the RPC's Unattributed row is exactly that case. */
const costPer = (spend, outcomes) =>
  spend > 0 && outcomes > 0 ? spend / outcomes : null;

const failures = [];
const notes = [];

// ---------------------------------------------------------------------------
// list_performance — one row per list, all time, no filters.
// ---------------------------------------------------------------------------
const { data: listData, error: listErr } = await sb.rpc("list_performance", {});
if (listErr) {
  console.error(`list_performance failed: ${listErr.message}`);
  process.exit(1);
}
const rows = (listData ?? []).map((r) => ({
  ...r,
  spend: n(r.spend),
}));

console.log(`list_performance returned ${rows.length} row(s).\n`);

const totals = {
  worked: 0,
  reached: 0,
  dms: 0,
  goals: 0,
  regs: 0,
  attended: 0,
  no_show: 0,
  pending: 0,
  spend: 0,
};

for (const r of rows) {
  const name = r.list_name ?? "(unattributed)";
  const settled = r.attended + r.no_show;

  // HARD INVARIANT. attended + no_show must not exceed regs — if it does, a
  // show rate above 100% is one division away and the panel's clamp is the
  // only thing standing between the reader and a nonsense number.
  if (settled > r.regs) {
    failures.push(
      `${name}: attended + no_show (${r.attended} + ${r.no_show} = ${settled}) exceeds regs (${r.regs}). ` +
        `A show rate above 100% would render without the clamp in settledCount().`,
    );
  }

  // SOFT NOTE, never a failure. calendly_events.scheduled_at is nullable, and
  // a live unattended registration with no session time satisfies neither the
  // no_show comparison nor the pending one, so it falls out of both buckets.
  // The migration header spells out that these three are NOT an exhaustive
  // partition of regs — do not turn this into an assertion.
  const unbucketed = r.regs - settled - r.pending;
  if (unbucketed !== 0) {
    notes.push(
      `${name}: ${unbucketed} registration(s) in neither attended, no_show nor pending ` +
        `(regs ${r.regs} − settled ${settled} − pending ${r.pending}). ` +
        `Expected when scheduled_at is null; not an invariant.`,
    );
  }

  const costReg = costPer(r.spend, r.regs);
  const showRate = settled > 0 ? Math.min(r.attended / settled, 1) : null;
  const projAtt =
    costReg !== null && showRate !== null && showRate > 0
      ? costReg / showRate
      : null;

  console.log(`  ${name}${r.is_inbound ? " [inbound]" : ""}`);
  console.log(
    `    worked ${r.worked}  reached ${r.reached}  dms ${r.dms}  goals ${r.goals}`,
  );
  console.log(
    `    regs ${r.regs}  attended ${r.attended}  settled ${settled}  pending ${r.pending}  show ${pct(showRate)}`,
  );
  console.log(
    `    spend ${money(r.spend)}  $/reg ${money(costReg)}  projected $/att ${money(projAtt)}`,
  );
  console.log("");

  totals.worked += r.worked;
  totals.reached += r.reached;
  totals.dms += r.dms;
  totals.goals += r.goals;
  totals.regs += r.regs;
  totals.attended += r.attended;
  totals.no_show += r.no_show;
  totals.pending += r.pending;
  totals.spend += r.spend;
}

const allSettled = totals.attended + totals.no_show;
const allShow =
  allSettled > 0 ? Math.min(totals.attended / allSettled, 1) : null;
const allCostReg = costPer(totals.spend, totals.regs);
const allProjAtt =
  allCostReg !== null && allShow !== null && allShow > 0
    ? allCostReg / allShow
    : null;

console.log("  ALL LISTS (what the panel renders)");
console.log(
  `    worked ${totals.worked}  reached ${totals.reached}  dms ${totals.dms}  goals ${totals.goals}`,
);
console.log(
  `    regs ${totals.regs}  attended ${totals.attended}  settled ${allSettled}  pending ${totals.pending}  show ${pct(allShow)}`,
);
console.log(
  `    spend ${money(totals.spend)}  $/reg ${money(allCostReg)}  projected $/att ${money(allProjAtt)}`,
);
console.log(
  `    naive spend/attended would read ${money(costPer(totals.spend, totals.attended))} — the number this panel refuses to print`,
);
console.log("");

// ---------------------------------------------------------------------------
// Cohort parity — the Cohorts tab must agree about the same registrations.
// ---------------------------------------------------------------------------
const { data: cohortData, error: cohortErr } = await sb.rpc("cohort_rows", {
  p_start: COHORT_START,
  p_end: COHORT_END,
});
if (cohortErr) {
  console.error(`cohort_rows failed: ${cohortErr.message}`);
  process.exit(1);
}
const cohort = { regs: 0, attended: 0, no_show: 0, pending: 0 };
for (const r of cohortData ?? []) {
  cohort.regs += r.regs;
  cohort.attended += r.attended;
  cohort.no_show += r.no_show;
  cohort.pending += r.pending;
}

console.log(
  `cohort_rows ${COHORT_START} → ${COHORT_END}: regs ${cohort.regs}  attended ${cohort.attended}  no_show ${cohort.no_show}  pending ${cohort.pending}`,
);
for (const key of ["regs", "attended", "no_show", "pending"]) {
  if (cohort[key] !== totals[key]) {
    failures.push(
      `cohort parity: ${key} is ${totals[key]} in list_performance but ${cohort[key]} in cohort_rows. ` +
        `The two pages are computing different show rates and one of them is lying.`,
    );
  }
}
console.log("");

// ---------------------------------------------------------------------------
if (notes.length > 0) {
  console.log("Notes (expected, not failures):");
  for (const note of notes) console.log(`  · ${note}`);
  console.log("");
}

if (failures.length === 0) {
  console.log(
    "All checks passed. Settled never exceeds regs, and Cohorts agrees with Analytics.",
  );
  process.exit(0);
}
console.error(`${failures.length} failure(s):`);
for (const f of failures) console.error(`  ✗ ${f}`);
process.exit(1);
