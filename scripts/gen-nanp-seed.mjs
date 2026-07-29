// Emits the VALUES rows for the nanp_area_codes seed from the TypeScript maps,
// so SQL and TS can never drift by hand-editing. Run with:
//   npx tsx scripts/gen-nanp-seed.mjs
import {
  STATE_AREA_CODES,
  PROVINCE_AREA_CODES,
} from "../src/lib/dialer/nanp-states.ts";

const rows = [];
for (const [state, codes] of Object.entries(STATE_AREA_CODES)) {
  for (const c of codes) rows.push(`('${c}', '${state}', 'US')`);
}
// Provinces populate the same `state` column: dial_queue compares that column
// between the lead and the campaign's numbers, so a same-province match has to
// look identical to a same-state one. No province code collides with a USPS
// state code, so one column is unambiguous.
for (const [province, codes] of Object.entries(PROVINCE_AREA_CODES)) {
  for (const c of codes) rows.push(`('${c}', '${province}', 'CA')`);
}

rows.sort();
console.log(rows.join(",\n"));
console.error(`-- ${rows.length} rows`);
