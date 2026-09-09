// src/lib/dialer/nanp-states.ts
/**
 * NANP (North American Numbering Plan) geographic area code -> USPS 2-letter
 * state abbreviation, plus the Canadian province equivalent further down.
 *
 * This is public, factual telephone-numbering-plan data (area code
 * assignments), covering all 50 states + DC. Built state-first
 * (`STATE_AREA_CODES`) for readability/maintainability, then inverted into a
 * flat lookup map at module load.
 *
 * Deliberately EXCLUDED (non-geographic, so they resolve to `null`):
 * toll-free (800/888/877/866/855/844/833), premium (900), and other
 * special-purpose codes (700, 500, 600, 911, 411, etc), along with codes NANPA
 * has assigned but not yet placed in service.
 *
 * Every state + DC is represented by at least its primary code(s).
 *
 * ⚠️ A wrong or missing code is not cosmetic:
 *
 *   • MISSING — `regionForAreaCode` returns null, so `number-pool` scores
 *     matchTier "none" and the lead is dialled with no local presence, even
 *     when we hold a number in its state.
 *   • WRONG STATE — worse, because it silently succeeds. We dial a Louisiana
 *     number at a Florida lead and record it as local_match "state", so the
 *     metric says local presence is working while the lead sees an out-of-
 *     state caller ID.
 *
 * Reconciled 2026-09-09 against the NANPA NPA Database itself — the primary
 * source, reports.nanpa.com/public/npa_report.csv, file dated 09/09/2026 —
 * rather than against hand-collected sightings. This file now carries every
 * in-service geographic NPA in the 50 states + DC, all 372 of them. That sweep
 * found:
 *
 *   • 31 codes missing outright, all overlays placed in service between 2019
 *     and 2026 (274, 283, 326, 353, 465, 471, 621, 686, 821, 948, …).
 *   • 2 codes filed under the WRONG state by the 2026-09-08 pass, which took a
 *     hand-written list on trust: 728 is Florida (the 561 Palm Beach overlay),
 *     not Louisiana, and 645 is Florida (the 305/786 Miami overlay), not
 *     Maryland. Both corrected here.
 *
 * That second bullet is why the tests now assert each overlay against NANPA's
 * own overlay complex instead of a claimed parent: a test pinning 728 to 985
 * passes contentedly while both sit in the wrong state.
 *
 * ⚠️ After ANY edit here, regenerate the SQL seed so the DB cannot drift:
 *      npx tsx scripts/gen-nanp-seed.mjs
 *
 * Out of scope, so they resolve to null: Puerto Rico (787/939) and the other
 * US territories (340 VI, 670 CNMI, 671 GU, 684 AS) — the scope here is the 50
 * states + DC — and the Caribbean NANP countries.
 */
export const STATE_AREA_CODES: Record<string, string[]> = {
  AL: ["205", "251", "256", "334", "483", "659", "938"],
  AK: ["907"],
  AZ: ["480", "520", "602", "623", "928"],
  AR: ["327", "479", "501", "870"],
  CA: [
    "209",
    "213",
    "279",
    "310",
    "323",
    "341",
    "350",
    "357",
    "369",
    "408",
    "415",
    "424",
    "442",
    "510",
    "530",
    "559",
    "562",
    "619",
    "626",
    "628",
    "650",
    "657",
    "661",
    "669",
    "707",
    "714",
    "738",
    "747",
    "760",
    "805",
    "818",
    "820",
    "831",
    "837",
    "840",
    "858",
    "909",
    "916",
    "925",
    "949",
    "951",
  ],
  CO: ["303", "719", "720", "748", "970", "983"],
  CT: ["203", "475", "860", "959"],
  DE: ["302"],
  DC: ["202", "771"],
  FL: [
    "239",
    "305",
    "321",
    "324",
    "352",
    "386",
    "407",
    "448",
    "561",
    "645",
    "656",
    "689",
    "727",
    "728",
    "754",
    "772",
    "786",
    "813",
    "850",
    "863",
    "904",
    "941",
    "954",
  ],
  GA: ["229", "404", "470", "478", "678", "706", "762", "770", "912", "943"],
  HI: ["808"],
  ID: ["208", "986"],
  IL: [
    "217",
    "224",
    "309",
    "312",
    "331",
    "447",
    "464",
    "618",
    "630",
    "708",
    "730",
    "773",
    "779",
    "815",
    "847",
    "861",
    "872",
  ],
  IN: ["219", "260", "317", "463", "574", "765", "812", "930"],
  IA: ["319", "515", "563", "641", "712"],
  KS: ["316", "620", "785", "913"],
  KY: ["270", "364", "502", "606", "859"],
  LA: ["225", "318", "337", "457", "504", "985"],
  ME: ["207"],
  MD: ["227", "240", "301", "410", "443", "667"],
  MA: ["339", "351", "413", "508", "617", "774", "781", "857", "978"],
  MI: [
    "231",
    "248",
    "269",
    "313",
    "517",
    "586",
    "616",
    "679",
    "734",
    "810",
    "906",
    "947",
    "989",
  ],
  MN: ["218", "320", "507", "612", "651", "763", "924", "952"],
  MS: ["228", "471", "601", "662", "769"],
  MO: ["235", "314", "417", "557", "573", "636", "660", "816", "975"],
  MT: ["406"],
  NE: ["308", "402", "531"],
  NV: ["702", "725", "775"],
  NH: ["603"],
  NJ: ["201", "551", "609", "640", "732", "848", "856", "862", "908", "973"],
  NM: ["505", "575"],
  NY: [
    "212",
    "315",
    "329",
    "332",
    "347",
    "363",
    "465",
    "516",
    "518",
    "585",
    "607",
    "624",
    "631",
    "646",
    "680",
    "716",
    "718",
    "838",
    "845",
    "914",
    "917",
    "929",
    "934",
  ],
  NC: ["252", "336", "472", "704", "743", "828", "910", "919", "980", "984"],
  ND: ["701"],
  OH: [
    "216",
    "220",
    "234",
    "283",
    "326",
    "330",
    "380",
    "419",
    "436",
    "440",
    "513",
    "567",
    "614",
    "740",
    "937",
  ],
  OK: ["405", "539", "572", "580", "918"],
  OR: ["458", "503", "541", "971"],
  PA: [
    "215",
    "223",
    "267",
    "272",
    "412",
    "445",
    "484",
    "570",
    "582",
    "610",
    "717",
    "724",
    "814",
    "835",
    "878",
  ],
  RI: ["401"],
  SC: ["803", "821", "839", "843", "854", "864"],
  SD: ["605"],
  TN: ["423", "615", "629", "729", "731", "865", "901", "931"],
  TX: [
    "210",
    "214",
    "254",
    "281",
    "325",
    "346",
    "361",
    "409",
    "430",
    "432",
    "469",
    "512",
    "621",
    "682",
    "713",
    "726",
    "737",
    "806",
    "817",
    "830",
    "832",
    "903",
    "915",
    "936",
    "940",
    "945",
    "956",
    "972",
    "979",
  ],
  UT: ["385", "435", "801"],
  VT: ["802"],
  VA: ["276", "434", "540", "571", "686", "703", "757", "804", "826", "948"],
  WA: ["206", "253", "360", "425", "509", "564"],
  WV: ["304", "681"],
  WI: ["262", "274", "353", "414", "534", "608", "715", "920"],
  WY: ["307"],
};

const AREA_CODE_TO_STATE: Record<string, string> = Object.fromEntries(
  Object.entries(STATE_AREA_CODES).flatMap(([state, codes]) =>
    codes.map((code) => [code, state] as const),
  ),
);

/** Map a US NANP area code to its 2-letter USPS state abbreviation (e.g.
 *  "FL"), or null when the code is unknown / non-geographic (toll-free,
 *  premium, etc.) or the input itself is null. Pure. */
export function stateForAreaCode(areaCode: string | null): string | null {
  if (!areaCode) return null;
  return AREA_CODE_TO_STATE[areaCode] ?? null;
}

/**
 * Canadian NANP area codes by province, in the same shape as
 * `STATE_AREA_CODES`. Two deliberate simplifications: 902/782 serve BOTH Nova
 * Scotia and Prince Edward Island and are filed under NS (they are one calling
 * region for local-presence purposes), and 867 covers Northwest Territories,
 * Nunavut and Yukon and is filed under NT.
 *
 * No province abbreviation collides with a USPS state abbreviation, so the two
 * maps can share one lookup without ambiguity.
 *
 * Reconciled against the same NANPA file on 2026-09-09: 257 (the Vancouver
 * 604 overlay, live 2025-05-24) and 942 (the Toronto 416 overlay, live
 * 2025-04-26) were missing and are added.
 *
 * 387 is the one entry NANPA does not corroborate: it is reserved for Canada
 * with no province assigned yet, so no lead can carry it and the row is inert.
 * Kept under ON — where a previous pass placed it — deliberately, because the
 * seed migration is a pure upsert and removing a code from this map would
 * strand the old row in the database.
 */
export const PROVINCE_AREA_CODES: Record<string, string[]> = {
  AB: ["368", "403", "587", "780", "825"],
  BC: ["236", "250", "257", "604", "672", "778"],
  MB: ["204", "431", "584"],
  NB: ["428", "506"],
  NL: ["709", "879"],
  NS: ["782", "902"],
  NT: ["867"],
  ON: [
    "226",
    "249",
    "289",
    "343",
    "365",
    "382",
    "387",
    "416",
    "437",
    "519",
    "548",
    "613",
    "647",
    "683",
    "705",
    "742",
    "753",
    "807",
    "905",
    "942",
  ],
  QC: [
    "263",
    "354",
    "367",
    "418",
    "438",
    "450",
    "468",
    "514",
    "579",
    "581",
    "819",
    "873",
  ],
  SK: ["306", "474", "639"],
};

const AREA_CODE_TO_PROVINCE: Record<string, string> = Object.fromEntries(
  Object.entries(PROVINCE_AREA_CODES).flatMap(([province, codes]) =>
    codes.map((code) => [code, province] as const),
  ),
);

/** Every Canadian NANP area code, derived from the province map. */
export const CANADA_AREA_CODES: ReadonlySet<string> = new Set(
  Object.keys(AREA_CODE_TO_PROVINCE),
);

/** Map a Canadian NANP area code to its 2-letter province abbreviation, or null.
 *  Pure. */
export function provinceForAreaCode(areaCode: string | null): string | null {
  if (!areaCode) return null;
  return AREA_CODE_TO_PROVINCE[areaCode] ?? null;
}

/** The state OR province for a geographic NANP area code — the unit the dialer
 *  treats as "same region" when no exact area-code match is available. Null for
 *  non-geographic codes (toll-free, premium). Pure. */
export function regionForAreaCode(areaCode: string | null): string | null {
  return stateForAreaCode(areaCode) ?? provinceForAreaCode(areaCode);
}

/** 'US' | 'CA' for a geographic NANP area code, else null (toll-free,
 *  premium, and other non-geographic codes have no destination country we
 *  can act on). Canada is checked FIRST — since provinces joined the region
 *  lookup, a Canadian code also resolves to a region. Pure. */
export function countryForAreaCode(
  areaCode: string | null | undefined,
): "US" | "CA" | null {
  if (!areaCode) return null;
  if (CANADA_AREA_CODES.has(areaCode)) return "CA";
  return stateForAreaCode(areaCode) ? "US" : null;
}
