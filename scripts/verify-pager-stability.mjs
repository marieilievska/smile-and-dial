// Prove every paged read returns each row exactly once.
//
//   node --env-file=.env.local scripts/verify-pager-stability.mjs [--runs=3]
//
// Postgres makes NO row-order guarantee across separate LIMIT/OFFSET queries.
// A `.range()` pager with no deterministic `.order()` can therefore hand the
// same row to two pages and never show another one at all -- silently, with no
// error. Measured on production 2026-09-07 against `calls` (7,798 rows, 8
// pages), four copies of the identical unordered pager running AT ONCE:
//
//     run 1: fetched=7798 distinct=5431 duplicates=2367
//     run 2: fetched=7798 distinct=5872 duplicates=1926
//     run 3: fetched=7798 distinct=4852 duplicates=2946
//     run 4: fetched=7798 distinct=5545 duplicates=2253
//
// A quarter to a third of the window counted twice, and as much again never
// seen at all. Run ONE AT A TIME the same pager was flawless every attempt --
// which is exactly why three of these shipped and survived review.
//
// The mechanism is parallel query. `calls` and `leads` are plain table scans,
// so Postgres may run them with parallel workers, and workers claim blocks
// dynamically: the row order depends on how many workers the query gets. Run
// four at once and the worker pool is contended, so each run is planned
// differently and the pages overlap. That is why concurrency is what exposes
// this, and why a quiet database hides it completely -- on an idle Labor Day
// morning every one of these pagers looked perfect.
//
// Ordering by a unique column (`id`) pins the row sequence, so page N+1 always
// resumes exactly where page N stopped, however the scan is executed.
//
// READ ONLY. Exit 0 = every pager stable, 1 = a pager lost or duplicated rows.

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

const RUNS = Number(
  process.argv.find((a) => a.startsWith("--runs="))?.slice(7) ?? 3,
);
const PAGE = 1000;

/** ET midnight `days` ago as a UTC instant -- mirrors etMidnightUtcIso. */
function etDaysAgoIso(days) {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
  }).format(new Date());
  const [y, m, d] = today.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() - days);
  const day = t.toISOString().slice(0, 10);
  const probe = new Date(`${day}T12:00:00Z`);
  const off =
    /GMT([+-]\d+)/.exec(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        timeZoneName: "shortOffset",
      }).format(probe),
    )?.[1] ?? "-5";
  const base = new Date(`${day}T00:00:00Z`);
  base.setUTCHours(base.getUTCHours() - Number(off));
  return base.toISOString();
}

/** Page one query to exhaustion. Returns the ids in the order seen AND the id
 *  set of each individual page. `build(from, to)` applies .range() itself. */
async function page(build, cap = 200_000) {
  const ids = [];
  const pages = [];
  for (let from = 0; from < cap; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const batch = data ?? [];
    const got = batch.map((r) => (typeof r === "string" ? r : r.id));
    ids.push(...got);
    pages.push(new Set(got));
    if (batch.length < PAGE) break;
  }
  return { ids, pages };
}

const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

/**
 * Run one pager `RUNS` times and judge it on two properties:
 *
 *   1. COMPLETENESS -- fetched === distinct on every run, and every run returns
 *      the same id set. This is the coarse test, and the one that actually
 *      costs users rows.
 *   2. PAGE STABILITY -- offset N returns the same rows on every run. This is
 *      the finer test: it detects the non-determinism ITSELF rather than
 *      waiting for an interleaving unlucky enough to lose a row. A pager can
 *      pass (1) by chance while failing (2), and a pager that fails (2) will
 *      eventually fail (1) in production.
 *
 * `concurrent` runs the copies simultaneously instead of back to back, which is
 * what production does when several people open the same page at once -- and
 * what contends the parallel worker pool, so each run gets planned differently.
 * This is the only arrangement that reproduces the defect; sequential runs of a
 * broken pager come back clean and prove nothing.
 */
async function check(label, build, { cap, concurrent = false } = {}) {
  const one = async () => {
    const t0 = Date.now();
    const { ids, pages } = await page(build, cap);
    return { ids, pages, set: new Set(ids), ms: Date.now() - t0 };
  };
  const runs = concurrent
    ? await Promise.all(Array.from({ length: RUNS }, one))
    : await (async () => {
        const out = [];
        for (let i = 0; i < RUNS; i++) out.push(await one());
        return out;
      })();

  const dirty = runs.filter((r) => r.ids.length !== r.set.size);
  const drift = runs.filter((r) => !sameSet(r.set, runs[0].set));
  // Which page offsets came back with different contents between runs?
  const unstablePages = [];
  for (let p = 0; p < runs[0].pages.length; p++) {
    if (runs.some((r) => !r.pages[p] || !sameSet(r.pages[p], runs[0].pages[p])))
      unstablePages.push(p * PAGE);
  }

  const ok = dirty.length === 0 && drift.length === 0 && !unstablePages.length;
  console.log(
    `${ok ? "OK  " : "FAIL"}  ${label}${concurrent ? "  [concurrent]" : ""}`,
  );
  for (const [i, r] of runs.entries()) {
    const dup = r.ids.length - r.set.size;
    console.log(
      `        run ${i + 1}: fetched=${String(r.ids.length).padStart(6)}` +
        ` distinct=${String(r.set.size).padStart(6)}` +
        ` duplicates=${String(dup).padStart(5)}` +
        ` ${String(r.ms).padStart(6)}ms` +
        (dup ? `   <- LOST ${dup} REAL ROWS` : ""),
    );
  }
  if (drift.length)
    console.log(
      `        ${drift.length}/${RUNS} run(s) returned a DIFFERENT id set than run 1`,
    );
  if (unstablePages.length)
    console.log(
      `        page contents drifted between runs at offset(s): ` +
        `${unstablePages.slice(0, 8).join(", ")}` +
        `${unstablePages.length > 8 ? ` …and ${unstablePages.length - 8} more` : ""}` +
        `  <- the row order is not deterministic`,
    );
  return ok;
}

const since30 = etDaysAgoIso(30);
console.log(
  `Pager stability -- ${RUNS} runs each, page size ${PAGE}, window from ${since30}\n`,
);

// Only the ORDERED pagers are scored. The unordered ones are reconstructions of
// the code being replaced: they are expected to misbehave, and scoring them
// would invert the meaning of the exit code (the script would "fail" precisely
// when it succeeded in demonstrating the bug). Exit 0 therefore means "every
// pager we ship returns each row exactly once", which is the claim worth making.
let failures = 0;
const record = (ok) => {
  if (!ok) failures++;
};

// ---------------------------------------------------------------- site 1
// src/lib/smart-lists/resolve.ts -- runFilterRpc pages leads_matching_filter.
// The function returns `setof uuid`; PostgREST cannot order it from the client
// (`column leads_matching_filter.leads_matching_filter does not exist`), so the
// order has to come from inside the function -- migration 20260907150000.
//
// Honest note: this site never drifted, sequentially OR concurrently, before
// that migration. It is plpgsql, therefore `parallel unsafe` by default,
// therefore its inner scan is never handed to the parallel workers that make
// the two pagers below non-deterministic. That protection is incidental, not
// designed: declaring the function `parallel safe` one day -- an ordinary
// optimisation -- would remove it silently. The migration makes the guarantee
// explicit. Treat a clean result here as "still explicit", not as proof the
// bug was ever visible.
//
// The recipe is bounded on purpose. An empty recipe matches all 84k live leads,
// and because a plpgsql set-returning function re-runs in FULL for every page,
// that is 85 pages x 84k rows = 7.1M row-visits per run against the live dialer
// database. "attempts > 0" matches 7,518 leads -- eight pages, the same shape
// as the `calls` evidence, at a tenth of the cost.
const RECIPE = {
  combinator: "and",
  children: [{ field: "attempts", operator: "gt", value: "0" }],
};
console.log("site 1  leads_matching_filter RPC (smart-list match count)");
{
  const q = (from, to) =>
    sb.rpc("leads_matching_filter", { in_recipe: RECIPE }).range(from, to);
  record(await check("        sequential", q, { cap: 40_000 }));
  // The function body is `select l.id from leads l where …` with no order by,
  // so each page re-runs that scan and is free to start somewhere else.
  record(
    await check("        concurrent", q, { cap: 40_000, concurrent: true }),
  );
}

// ---------------------------------------------------------------- site 2
// src/lib/twilio/pool-actions.ts:515 -- lead area codes behind a campaign.
console.log("\nsite 2  leads.business_phone by campaign (number-buying plan)");
{
  const { data: atts } = await sb
    .from("list_campaign_attachments")
    .select("campaign_id, list_id")
    .is("detached_at", null);
  const byCampaign = new Map();
  for (const a of atts ?? []) {
    const s = byCampaign.get(a.campaign_id) ?? new Set();
    s.add(a.list_id);
    byCampaign.set(a.campaign_id, s);
  }
  // The campaign with the most leads -- the one that actually pages.
  let biggest = null;
  for (const listIds of byCampaign.values()) {
    const { count } = await sb
      .from("leads")
      .select("id", { count: "exact", head: true })
      .in("list_id", [...listIds])
      .is("deleted_at", null)
      .not("business_phone", "is", null);
    if (!biggest || (count ?? 0) > biggest.count)
      biggest = { listIds: [...listIds], count: count ?? 0 };
  }
  if (!biggest || biggest.count <= PAGE) {
    console.log(
      `SKIP    no campaign has more than ${PAGE} phone-bearing leads -- nothing pages`,
    );
  } else {
    const q = (from, to) =>
      sb
        .from("leads")
        .select("id, business_phone")
        .in("list_id", biggest.listIds)
        .is("deleted_at", null)
        .not("business_phone", "is", null)
        .range(from, to);
    await check(`        before: unordered   ${biggest.count} leads`, q, {
      cap: 120_000,
    });
    record(
      await check(
        `        after:  order by id  ${biggest.count} leads`,
        (from, to) => q(from, to).order("id", { ascending: true }),
        { cap: 120_000 },
      ),
    );
  }
}

// ------------------------------------------------------- the demonstration
// NOT a live call site. This is the pager that used to sit in
// src/app/(app)/reporting/numbers-panel.tsx, deleted by #488 when the Numbers
// tab moved its counting into the number_performance_summary RPC. It is kept
// here because it is the clearest reproduction of the hazard we have: a real
// table, a real 8-page window, and a defect you can watch happen. The two live
// sites above are both awkward to demonstrate on -- one is protected by an
// accident of plpgsql, the other takes 20 seconds a run -- so this is what
// actually shows a reviewer why the `.order()` matters.
console.log("\ndemo    calls, 30-day outbound window (the pager #488 deleted)");
{
  const q = (from, to) =>
    sb
      .from("calls")
      .select("id, outcome, local_match, dest_country, twilio_number_id")
      .eq("direction", "outbound")
      .gte("created_at", since30)
      .range(from, to);
  await check("        before: unordered, sequential", q, { cap: 100_000 });
  // The same pager run several times AT ONCE -- what happened whenever more
  // than one person had Reporting open. Contending the parallel worker pool is
  // what makes each run plan differently, and it is the only arrangement that
  // reproduces the defect on demand. A clean result here proves nothing (see
  // the header); a dirty one proves everything.
  const contended = await check("        before: unordered, CONCURRENT", q, {
    cap: 100_000,
    concurrent: true,
  });
  if (contended)
    console.log(
      "        (clean -- but that only means nothing interfered THIS time)",
    );
  record(
    await check(
      "        after:  order by id, concurrent",
      (from, to) => q(from, to).order("id", { ascending: true }),
      { cap: 100_000, concurrent: true },
    ),
  );
}

// ------------------------------------------------------------- tiebreakers
// The pagers that DO order, but on a non-unique column, and now carry a
// tiebreaker: `created_at, id` on calls (Today, the Calls/Campaigns/Leads stat
// strips, Analytics costs) and the full `(et_day, campaign_id, list_id,
// owner_id)` grain on cost_rollup_daily, which has no `id` column at all.
//
// Two things are being checked that the sections above do not cover: that a
// MULTI-COLUMN sort still pages completely (it is a different query plan), and
// that ordering by columns the select omits is accepted rather than silently
// erroring — most of these call sites destructure `{ data }` and drop the
// error, so a rejected order column would read as zero rows, not as a failure.
console.log("\ntiebreakers  non-unique sort keys, now made total");
{
  record(
    await check(
      "        calls by (created_at, id)",
      // `id` IS selected here purely so this check can tell the rows apart —
      // the shipped queries omit it, and that they are still accepted is what
      // the `_shapes` sweep proves. What is under test here is whether the
      // two-column sort pages completely.
      (from, to) =>
        sb
          .from("calls")
          .select("id, outcome, goal_met, lead_id")
          .gte("created_at", since30)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to),
      { cap: 100_000, concurrent: true },
    ),
  );

  const rollup = (from, to) =>
    sb
      .from("cost_rollup_daily")
      .select("et_day, campaign_id, list_id, owner_id, total")
      .order("et_day", { ascending: false })
      .order("campaign_id", { ascending: true, nullsFirst: false })
      .order("list_id", { ascending: true })
      .order("owner_id", { ascending: true })
      .range(from, to)
      .then((r) => ({
        // No id column: the grain itself is the identity.
        data: (r.data ?? []).map((x) => ({
          id: `${x.et_day}|${x.campaign_id}|${x.list_id}|${x.owner_id}`,
        })),
        error: r.error,
      }));
  record(
    await check("        cost_rollup_daily by full grain", rollup, {
      cap: 100_000,
      concurrent: true,
    }),
  );
}

console.log();
if (failures === 0) {
  console.log(
    "Every pager returned each row exactly once, identically on every run.",
  );
  process.exit(0);
}
console.error(
  `${failures} pager(s) duplicated or lost rows. An unordered .range() loop cannot be trusted.`,
);
process.exit(1);
