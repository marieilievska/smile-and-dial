// Prove the number_performance_summary SQL agrees with the JavaScript it
// replaced.
//
//   node --experimental-strip-types --env-file=.env.local \
//     scripts/verify-numbers-parity.mjs
//   (or: npm run verify:numbers)
//
// The Reporting Numbers tab used to page every outbound call in the window
// 1,000 rows at a time and walk the result building three Maps: connect rate
// by local-presence tier, by destination country and by phone number. It now
// calls one aggregate, `number_performance_summary` (migration 20260907110000).
//
// The loop below is that JavaScript, rewritten here — but the RULE it depends
// on is imported, not transcribed: CONNECTED_OUTCOMES and NON_CALL_OUTCOMES
// come from the real src/lib/calls/outcomes.ts (via --experimental-strip-types),
// the same module the panel imported. A checker that re-typed the eleven
// connected outcomes could make the same misreading as the SQL and call it
// agreement. Everything else here is bookkeeping the shape of the data will
// catch on its own.
//
// Compares, per window: every key of all three maps, and both integers under
// each — plus the key SETS in each direction, so a tier or a number present on
// one side and missing on the other fails rather than being skipped.
//
// READ ONLY. Exit 0 = identical, 1 = a difference.

import { register } from "node:module";

import { createClient } from "@supabase/supabase-js";

// outcomes.ts imports "@/lib/labels", an alias node knows nothing about, so the
// hook has to be registered before the module loads — which means a dynamic
// import here (a static one would be hoisted above the register call).
register("./ts-path-alias.mjs", import.meta.url);
const { CONNECTED_OUTCOMES, NON_CALL_OUTCOMES } =
  await import("../src/lib/calls/outcomes.ts");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.",
  );
  process.exit(1);
}
const sb = createClient(url, serviceKey);

/** The OLD path: page every outbound call, bump three Maps.
 *
 *  ONE DELIBERATE DIFFERENCE from the code this replaced: the `.order("id")`
 *  below. The panel paged with `.range()` and no ordering at all, and Postgres
 *  gives no row order across separate LIMIT/OFFSET queries — so pages
 *  overlapped. Measured on production 2026-09-07, same window, twice in a row:
 *
 *      run A: fetched=7798 distinct=5525 duplicates=2273
 *      run B: fetched=7798 distinct=7798 duplicates=0
 *
 *  Run A counted 2,273 calls twice and never saw 2,273 others — 29% of the
 *  window, silently, differently on each load. That is why the first run of
 *  this script reported 180 differences and the second reported none.
 *
 *  Ordering here is not cheating: it makes the JS compute what it was always
 *  meant to compute, so the comparison is about the SQL and not about which
 *  rows the pager happened to serve twice. */
async function aggregateInJs(since) {
  const PAGE = 1000;
  const calls = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("calls")
      .select("outcome, local_match, dest_country, twilio_number_id")
      .eq("direction", "outbound")
      .gte("created_at", since)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`calls page ${from}: ${error.message}`);
    const page = data ?? [];
    calls.push(...page);
    if (page.length < PAGE) break;
  }

  const byMatch = new Map();
  const byCountry = new Map();
  const byNumber = new Map();
  for (const c of calls) {
    // ai_error is OUR platform failure — out of the numerator AND denominator.
    if (c.outcome !== null && NON_CALL_OUTCOMES.has(c.outcome)) continue;
    const connected = c.outcome !== null && CONNECTED_OUTCOMES.has(c.outcome);
    const bump = (m, k) => {
      const r = m.get(k) ?? { calls: 0, connected: 0 };
      r.calls++;
      if (connected) r.connected++;
      m.set(k, r);
    };
    if (c.local_match) bump(byMatch, c.local_match);
    if (c.dest_country) bump(byCountry, c.dest_country);
    if (c.twilio_number_id) bump(byNumber, c.twilio_number_id);
  }
  return {
    scanned: calls.length,
    byMatch: Object.fromEntries(byMatch),
    byCountry: Object.fromEntries(byCountry),
    byNumber: Object.fromEntries(byNumber),
  };
}

async function aggregateInSql(since) {
  const { data, error } = await sb.rpc("number_performance_summary", {
    p_since: since,
  });
  if (error) throw new Error(`rpc: ${error.message}`);
  return data ?? {};
}

// --- comparison ------------------------------------------------------------

let failures = 0;
const problems = [];

function cmp(label, a, b) {
  if (a !== b) {
    failures++;
    problems.push(`    ${label}: js=${a} sql=${b}`);
  }
}

/** Compare one {key: {calls, connected}} section, both directions. */
function cmpSection(name, js, sql) {
  const keys = new Set([...Object.keys(js), ...Object.keys(sql)]);
  for (const k of [...keys].sort()) {
    const j = js[k];
    const s = sql[k];
    if (!j || !s) {
      failures++;
      problems.push(
        `    ${name}[${k}]: present only in ${j ? "js" : "sql"}` +
          ` (${JSON.stringify(j ?? s)})`,
      );
      continue;
    }
    cmp(`${name}[${k}].calls`, j.calls, Number(s.calls));
    cmp(`${name}[${k}].connected`, j.connected, Number(s.connected));
  }
  return keys.size;
}

/** ET-midnight ISO for N days ago — the window the panel uses. */
function etMidnightDaysAgo(days) {
  const d = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() - days * 86_400_000));
  // Offset from the same helper the app uses would need the TS module; the
  // exact instant does not matter for parity as long as BOTH sides get it.
  return new Date(`${d}T00:00:00-04:00`).toISOString();
}

// A 1-day window and a 3,650-day one both matter: the point of the rewrite is
// that cost stops scaling with the row count, so the widest window must agree
// as exactly as the narrowest.
const WINDOWS = [1, 3, 7, 14, 30, 90, 3650];

console.log(
  "Verifying number_performance_summary against the JS it replaced\n",
);

for (const days of WINDOWS) {
  const since = etMidnightDaysAgo(days);
  const before = failures;

  const t0 = Date.now();
  const js = await aggregateInJs(since);
  const jsMs = Date.now() - t0;

  const t1 = Date.now();
  const sql = await aggregateInSql(since);
  const sqlMs = Date.now() - t1;

  const nMatch = cmpSection("byMatch", js.byMatch, sql.byMatch ?? {});
  const nCountry = cmpSection("byCountry", js.byCountry, sql.byCountry ?? {});
  const nNumber = cmpSection("byNumber", js.byNumber, sql.byNumber ?? {});

  const ok = failures === before;
  const speedup = sqlMs > 0 ? `${(jsMs / sqlMs).toFixed(1)}×` : "—";
  console.log(
    `${ok ? "OK  " : "FAIL"} ${String(days).padStart(4)}d  ` +
      `${String(js.scanned).padStart(5)} calls scanned by JS  ` +
      `${nMatch} tiers / ${nCountry} countries / ${nNumber} numbers  ` +
      `js ${String(jsMs).padStart(5)}ms  sql ${String(sqlMs).padStart(4)}ms  ` +
      `(${speedup})`,
  );
  if (!ok) console.log(problems.splice(0).join("\n"));
}

if (failures === 0) {
  console.log("\nIdentical on every window.");
  process.exit(0);
}
console.error(
  `\n${failures} difference(s). number_performance_summary and the JS disagree.`,
);
process.exit(1);
