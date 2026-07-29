// Emits the VALUES rows for the nanp_area_codes seed from the TypeScript maps,
// so SQL and TS can never drift by hand-editing. Run with:
//   npx tsx scripts/gen-nanp-seed.mjs
import {
  STATE_AREA_CODES,
  CANADA_AREA_CODES,
} from "../src/lib/dialer/nanp-states.ts";

const rows = [];
for (const [state, codes] of Object.entries(STATE_AREA_CODES)) {
  for (const c of codes) rows.push(`('${c}', '${state}', 'US')`);
}
for (const c of CANADA_AREA_CODES) rows.push(`('${c}', null, 'CA')`);

rows.sort();
console.log(rows.join(",\n"));
console.error(`-- ${rows.length} rows`);
