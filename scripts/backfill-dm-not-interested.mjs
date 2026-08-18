// One-time backfill: mark leads' sticky `decision_maker_reached` = true for any
// lead that has a `not_interested` call. Rationale: the disposition prompt
// defines not_interested as "the DECISION MAKER … clearly declined", so those
// calls always reached the decision-maker — but the AI rarely set the standalone
// flag, so history under-counts decision-makers. The post-call webhook now sets
// this at call time (src/lib/calls/decision-maker.ts:outcomeImpliesDm); this
// script fixes the PAST so Analytics windows over old data read correctly too.
//
// NOTE (Phase 2, 2026-08-18): the classifier now downgrades a not_interested whose
// extractor said decision_maker_reached != "yes" to gatekeeper_not_interested
// (src/lib/calls/classify-outcome.ts), so going forward a surviving not_interested
// IS dm=yes — this backfill stays valid but only matters for PRE-guard history.
//
// SAFE BY DEFAULT: dry-run — prints what WOULD change and writes nothing.
// Pass --apply to perform the update. The write is guarded to
// `decision_maker_reached=is.false`, so it only ever flips false→true for the
// affected leads (idempotent, and it can never overwrite a true or touch an
// unrelated row). Reads .env.local. NOTE: the flag is operator-correctable; a
// lead a human deliberately set to "No" cannot be distinguished from one never
// reached, so eyeball the sample before applying.
import { readFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply");

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1).replace(/^["']|["']$/g, "")];
    }),
);
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const CHUNK = 200;

// 1) Distinct lead ids that have at least one not_interested call (paginated).
const notInterestedLeadIds = new Set();
for (let offset = 0; ; offset += 1000) {
  const res = await fetch(
    `${URL_}/rest/v1/calls?select=lead_id&outcome=eq.not_interested&limit=1000&offset=${offset}`,
    { headers: H },
  );
  const batch = await res.json();
  if (!res.ok) {
    console.error("Fetch calls failed:", res.status, batch);
    process.exit(1);
  }
  for (const c of batch) if (c.lead_id) notInterestedLeadIds.add(c.lead_id);
  if (batch.length < 1000) break;
}
console.log(`Leads with >=1 not_interested call: ${notInterestedLeadIds.size}`);

// 2) Of those, which currently have decision_maker_reached = false?
const ids = [...notInterestedLeadIds];
const affected = [];
for (let i = 0; i < ids.length; i += CHUNK) {
  const chunk = ids.slice(i, i + CHUNK);
  const res = await fetch(
    `${URL_}/rest/v1/leads?select=id,company,decision_maker_reached` +
      `&id=in.(${chunk.join(",")})&decision_maker_reached=is.false`,
    { headers: H },
  );
  const batch = await res.json();
  if (!res.ok) {
    console.error("Fetch leads failed:", res.status, batch);
    process.exit(1);
  }
  affected.push(...batch);
}

console.log(
  `\nWould flip decision_maker_reached false -> true on ${affected.length} lead(s).`,
);
console.log("Sample (up to 15):");
for (const l of affected.slice(0, 15)) {
  console.log(`  ${l.id}  ${l.company ?? "(no company)"}`);
}

if (!APPLY) {
  console.log(
    `\nDRY RUN — nothing written. Re-run with --apply to update these ${affected.length} lead(s).`,
  );
  process.exit(0);
}

// 3) Apply — guarded so we only ever flip the intended false->true rows.
let updated = 0;
const affectedIds = affected.map((l) => l.id);
for (let i = 0; i < affectedIds.length; i += CHUNK) {
  const chunk = affectedIds.slice(i, i + CHUNK);
  const res = await fetch(
    `${URL_}/rest/v1/leads?id=in.(${chunk.join(",")})&decision_maker_reached=is.false`,
    {
      method: "PATCH",
      headers: {
        ...H,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({ decision_maker_reached: true }),
    },
  );
  const out = await res.json();
  if (!res.ok) {
    console.error("Update failed:", res.status, out);
    process.exit(1);
  }
  updated += out.length;
}
console.log(
  `\nAPPLIED — flipped ${updated} lead(s) to decision_maker_reached = true.`,
);
