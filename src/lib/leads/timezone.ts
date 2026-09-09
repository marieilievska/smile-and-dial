import { stateForAreaCode } from "@/lib/dialer/nanp-states";

// US state -> IANA timezone. State-level is an approximation (a few states
// span zones); BUILD_PLAN.md Section 5.1 uses state as the primary signal.

const STATE_TIMEZONES: Record<string, string> = {
  AL: "America/Chicago",
  AK: "America/Anchorage",
  AZ: "America/Phoenix",
  AR: "America/Chicago",
  CA: "America/Los_Angeles",
  CO: "America/Denver",
  CT: "America/New_York",
  DC: "America/New_York",
  DE: "America/New_York",
  FL: "America/New_York",
  GA: "America/New_York",
  HI: "Pacific/Honolulu",
  IA: "America/Chicago",
  ID: "America/Denver",
  IL: "America/Chicago",
  IN: "America/New_York",
  KS: "America/Chicago",
  KY: "America/New_York",
  LA: "America/Chicago",
  MA: "America/New_York",
  MD: "America/New_York",
  ME: "America/New_York",
  MI: "America/New_York",
  MN: "America/Chicago",
  MO: "America/Chicago",
  MS: "America/Chicago",
  MT: "America/Denver",
  NC: "America/New_York",
  ND: "America/Chicago",
  NE: "America/Chicago",
  NH: "America/New_York",
  NJ: "America/New_York",
  NM: "America/Denver",
  NV: "America/Los_Angeles",
  NY: "America/New_York",
  OH: "America/New_York",
  OK: "America/Chicago",
  OR: "America/Los_Angeles",
  PA: "America/New_York",
  RI: "America/New_York",
  SC: "America/New_York",
  SD: "America/Chicago",
  TN: "America/Chicago",
  TX: "America/Chicago",
  UT: "America/Denver",
  VA: "America/New_York",
  VT: "America/New_York",
  WA: "America/Los_Angeles",
  WI: "America/Chicago",
  WV: "America/New_York",
  WY: "America/Denver",
};

const STATE_NAME_TO_CODE: Record<string, string> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  "district of columbia": "DC",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
};

/** The IANA timezones our US + Canadian lead data uses, paired with a short,
 *  scannable label, ordered east → west. Single source of truth for the Leads
 *  "Time zone" column and its filter dropdown so the two always agree. Canadian
 *  leads collapse onto the matching US zone where DST rules are identical
 *  (Pacific/Mountain/Central/Eastern); the distinct ones — Atlantic and
 *  Saskatchewan (Central, no DST) — are listed separately. (Newfoundland is
 *  folded into Atlantic per ops preference, so it isn't its own option.) */
export const LEAD_TIMEZONES: { value: string; label: string }[] = [
  { value: "America/Halifax", label: "Atlantic" },
  { value: "America/New_York", label: "Eastern" },
  { value: "America/Chicago", label: "Central" },
  { value: "America/Regina", label: "Saskatchewan" },
  { value: "America/Denver", label: "Mountain" },
  { value: "America/Phoenix", label: "Arizona" },
  { value: "America/Los_Angeles", label: "Pacific" },
  { value: "America/Anchorage", label: "Alaska" },
  { value: "Pacific/Honolulu", label: "Hawaii" },
];

const TIMEZONE_LABELS = new Map(LEAD_TIMEZONES.map((t) => [t.value, t.label]));

/** Short, human label for a lead's IANA timezone ("America/New_York" →
 *  "Eastern"). Falls back to the city portion of the IANA id for anything
 *  outside the curated US set, and an em dash when there's no timezone. */
export function timezoneLabel(tz: string | null | undefined): string {
  if (!tz) return "—";
  const known = TIMEZONE_LABELS.get(tz);
  if (known) return known;
  return tz.split("/").pop()?.replace(/_/g, " ") || tz;
}

/** Best-effort IANA timezone for a US state or Canadian province (2-letter
 *  code or full name). */
export function stateToTimezone(
  state: string | null | undefined,
): string | null {
  if (!state) return null;
  const trimmed = state.trim();
  if (!trimmed) return null;
  if (trimmed.length === 2) {
    const up = trimmed.toUpperCase();
    return STATE_TIMEZONES[up] ?? CA_PROVINCE_TIMEZONES[up] ?? null;
  }
  const lower = trimmed.toLowerCase();
  const usCode = STATE_NAME_TO_CODE[lower];
  if (usCode) return STATE_TIMEZONES[usCode];
  const caCode = CA_PROVINCE_NAME_TO_CODE[lower];
  return caCode ? CA_PROVINCE_TIMEZONES[caCode] : null;
}

// NANP area code -> US state, so we can recover a state (and thus a timezone)
// from a phone number when the CSV had no state column. State-level only, same
// approximation as STATE_TIMEZONES. The map itself lives in
// src/lib/dialer/nanp-states.ts and is shared with the dialer.
//
// This file used to keep a second, private copy of that map. It drifted: by
// 2026-09-09 the copy was 29 in-service area codes behind, and every one of
// those was a lead we could not place in a timezone at all. That is not a
// silent no-op. `is_within_calling_hours` resolves a null lead timezone with
// `coalesce(lead_timezone, 'America/New_York')`, and Eastern is the EARLIEST
// US zone — so an unresolved California code did not stop the call, it opened
// a 9am calling window at 6am local, under the 8am floor. Two maps of the same
// facts cannot both be right for long; there is now one, reconciled against
// the NANPA NPA Database itself.
//
// `stateForAreaCode` is US-only by design — Canadian codes resolve through
// `provinceForAreaCode` over there, and through CA_AREA_CODE_TO_TIMEZONE
// below for zoning — so `stateFromPhone` still returns null for them.

// --- Canada -----------------------------------------------------------------
// Canadian numbers share the NANP (+1) but none of the US tables above cover
// them, so Canadian leads were left with NO timezone (or a wrong default).
//
// Each Canadian area code maps to a CANONICAL IANA zone chosen so the Leads
// timezone column / filter group naturally with their US equivalents. BC↔Pacific,
// AB↔Mountain, MB↔Central, and ON/QC↔Eastern share identical DST rules with the
// US zones, so we store the US zone string (a Toronto number → America/New_York,
// shown as "Eastern"). The genuinely-distinct Canadian zones keep their own IANA
// id: Atlantic (America/Halifax) and Saskatchewan (America/Regina — Central
// WITHOUT DST). Newfoundland (UTC-3:30) is folded into Atlantic per ops
// preference. Calling-hours math is otherwise identical; this just keeps the UI
// to one "Pacific", one "Eastern".
const CA_AREA_CODE_TO_TIMEZONE: Record<string, string> = {
  // British Columbia — Pacific
  "236": "America/Los_Angeles",
  "250": "America/Los_Angeles",
  "257": "America/Los_Angeles",
  "604": "America/Los_Angeles",
  "672": "America/Los_Angeles",
  "778": "America/Los_Angeles",
  // Alberta — Mountain
  "368": "America/Denver",
  "403": "America/Denver",
  "587": "America/Denver",
  "780": "America/Denver",
  "825": "America/Denver",
  // Saskatchewan — Central, NO daylight saving (America/Regina)
  "306": "America/Regina",
  "474": "America/Regina",
  "639": "America/Regina",
  // Manitoba — Central
  "204": "America/Chicago",
  "431": "America/Chicago",
  "584": "America/Chicago",
  // Ontario — Eastern
  "226": "America/New_York",
  "249": "America/New_York",
  "289": "America/New_York",
  "343": "America/New_York",
  "365": "America/New_York",
  "382": "America/New_York",
  "416": "America/New_York",
  "437": "America/New_York",
  "519": "America/New_York",
  "548": "America/New_York",
  "613": "America/New_York",
  "647": "America/New_York",
  "683": "America/New_York",
  "705": "America/New_York",
  "742": "America/New_York",
  "753": "America/New_York",
  "807": "America/New_York", // NW Ontario: Thunder Bay (Eastern) predominates over Kenora (Central)
  "905": "America/New_York",
  // Quebec — Eastern
  "263": "America/New_York",
  "354": "America/New_York",
  "367": "America/New_York",
  "418": "America/New_York",
  "438": "America/New_York",
  "450": "America/New_York",
  "468": "America/New_York",
  "514": "America/New_York",
  "579": "America/New_York",
  "581": "America/New_York",
  "819": "America/New_York",
  "873": "America/New_York",
  // New Brunswick / Nova Scotia / PEI — Atlantic
  "428": "America/Halifax",
  "506": "America/Halifax",
  "782": "America/Halifax",
  "902": "America/Halifax",
  // Newfoundland & Labrador — grouped with Atlantic per ops preference. Their
  // true zone is Newfoundland Time (UTC-3:30), but we treat NL as Atlantic so
  // there isn't a separate half-hour bucket on the board / in the dialer.
  "709": "America/Halifax",
  "879": "America/Halifax",
  // Territories (Yukon / NWT / Nunavut share 867) — best-effort Mountain.
  "867": "America/Denver",
};

// Canadian province (2-letter code or full name) -> canonical IANA zone, for
// leads that carry a province in the `state` field. Same canonical-zone scheme
// as the area-code table above. No US 2-letter code collides with these.
const CA_PROVINCE_TIMEZONES: Record<string, string> = {
  BC: "America/Los_Angeles",
  AB: "America/Denver",
  SK: "America/Regina",
  MB: "America/Chicago",
  ON: "America/New_York",
  QC: "America/New_York",
  NB: "America/Halifax",
  NS: "America/Halifax",
  PE: "America/Halifax",
  NL: "America/Halifax", // grouped with Atlantic per ops preference (see above)
  YT: "America/Denver",
  NT: "America/Denver",
  NU: "America/New_York",
};

const CA_PROVINCE_NAME_TO_CODE: Record<string, string> = {
  "british columbia": "BC",
  alberta: "AB",
  saskatchewan: "SK",
  manitoba: "MB",
  ontario: "ON",
  quebec: "QC",
  québec: "QC",
  "new brunswick": "NB",
  "nova scotia": "NS",
  "prince edward island": "PE",
  "newfoundland and labrador": "NL",
  newfoundland: "NL",
  labrador: "NL",
  yukon: "YT",
  "northwest territories": "NT",
  nunavut: "NU",
};

// Area code -> IANA timezone, for the area codes that fall in a DIFFERENT
// zone than their state's default (STATE_TIMEZONES). Several states span two
// time zones, so mapping by state alone misroutes calling-hours — e.g. a 915
// El Paso number would be put on Central time with the rest of Texas. This
// table overrides the state fallback for those split-state area codes; any
// area code NOT listed here keeps using the state's single timezone, so we
// only need to enumerate the exceptions, not every NANP code.
//
// Assignment is by where the area code predominantly sits. A handful of codes
// straddle a zone boundary internally (e.g. ND's 701, NE's 308); those are
// assigned to the zone covering most of their territory.
//
// ⚠️ When a code is ADDED to the shared map in src/lib/dialer/nanp-states.ts,
// check it here too. The dialer only needs the state, so a new code costs it
// nothing; here a code in a split state takes its state's DEFAULT zone, which
// can be the wrong one — and a wrong zone is worse than the missing one it
// replaced, because it silently succeeds: calling hours are computed, the lead
// looks placed, and the window is simply an hour off. NANPA's own TIME_ZONE
// column names the split ones ("EC", "CM", "MP"); 448 (FL) and 729 (TN) both
// arrived that way on 2026-09-09 and both needed a row here.
const AREA_CODE_TO_TIMEZONE: Record<string, string> = {
  // Texas — mostly Central; the far west (El Paso, Hudspeth) is Mountain.
  "915": "America/Denver", // El Paso
  // 432 is NOT Mountain, though it was listed here as "El Paso-region" until
  // 2026-09-09. 49 CFR 71.7(e) runs the boundary along the EAST LINE OF
  // HUDSPETH COUNTY, so Texas's mountain zone is El Paso + Hudspeth (plus a
  // sliver of northwest Culberson) — all 915. 432 is the Permian Basin:
  // Midland (~180k) and Ector/Odessa (~165k), every county Central. NANPA
  // agrees, marking 915 "CM" and every other Texas code, 432 included, plain
  // "C". It stays Central via the TX state default.

  // Florida — mostly Eastern; the western panhandle is Central.
  "850": "America/Chicago", // Pensacola / Panama City panhandle
  "448": "America/Chicago", // overlay on 850 (NANPA complex 448/850)

  // Tennessee — East TN is Eastern; Middle/West TN is Central.
  "423": "America/New_York", // Chattanooga / Knoxville region (Eastern)
  "729": "America/New_York", // overlay on 423 (NANPA complex 423/729)
  "865": "America/New_York", // Knoxville (Eastern)
  // 615/629 (Nashville), 731 (Jackson), 901 (Memphis), 931 stay Central
  // via the TN state default.

  // Kentucky — eastern/central KY is Eastern; western KY is Central.
  "270": "America/Chicago", // Bowling Green / western KY (Central)
  "364": "America/Chicago", // western KY overlay (Central)
  // 502 (Louisville), 859 (Lexington), 606 (eastern) stay Eastern via state.

  // Indiana — mostly Eastern; the northwest (Gary) + a SW pocket are Central.
  "219": "America/Chicago", // Gary / northwest Indiana (Central)

  // Michigan — Lower Peninsula Eastern; four western UP counties are Central.
  "906": "America/New_York", // Upper Peninsula — predominantly Eastern.

  // North Dakota — mostly Central; the southwest is Mountain.
  "701": "America/Chicago", // statewide code, predominantly Central.

  // South Dakota — eastern half Central, western half (Black Hills) Mountain.
  "605": "America/Chicago", // statewide code, predominantly Central.

  // Nebraska — eastern Central; the panhandle is Mountain. 308 covers both
  // (NANPA "CM"), so it goes to whichever holds more people, and that is
  // Central by a wide margin: the mountain-zone panhandle is 82,567 across the
  // 13 counties usually counted, 99,488 on the most generous reading, while
  // nine of 308's ~70 central-zone counties alone — Hall (Grand Island),
  // Buffalo (Kearney), Adams (Hastings), Lincoln (North Platte), Dawson,
  // Phelps, Red Willow, Custer, Holt — come to 243,499. It was pinned to
  // Mountain until 2026-09-09, which had it on the smaller half.
  "308": "America/Chicago", // central Nebraska outweighs the panhandle
  // 402/531 (Omaha/Lincoln) stay Central via the NE state default.

  // Kansas — mostly Central; four far-western counties are Mountain.
  "620": "America/Chicago", // southern/western KS, predominantly Central.

  // Oregon — mostly Pacific; Malheur County (far east) is Mountain.
  "541": "America/Los_Angeles", // statewide-ish, predominantly Pacific.
  "458": "America/Los_Angeles", // overlay on 541, predominantly Pacific.

  // Idaho — north Idaho (incl. 208 panhandle) is Pacific; south is Mountain.
  // The state default is Mountain; the panhandle is the exception, but 208
  // and its overlay 986 both cover the whole state, so leave them on the
  // Mountain state default. Idaho splits at the Salmon River, and Mountain
  // holds the people: the ten northern counties total 400,362 — an upper
  // bound, since Idaho County is itself split — against 1,146,165 in five
  // southern counties alone (Ada 546,141, Canyon, Bonneville, Bannock, Twin
  // Falls).
  //
  // ⚠️ Do NOT "correct" 986 to Pacific from the NANPA CSV. That file marks 986
  // "P" while marking 208 — the very code 986 overlays, with the identical
  // statewide footprint — "MP". A statewide overlay cannot touch fewer zones
  // than its parent, so the "P" is a quirk in that column, not a fact about
  // Idaho. It is the one place here we knowingly depart from NANPA.
};

// --- City, for the states no area code can split ---------------------------
// AREA_CODE_TO_TIMEZONE above works because those states have a code on each
// side of the line: 915 against 214, 850 against 305, 423 against 615. Idaho
// has no such pair. 208 and its overlay 986 BOTH cover the whole state, so no
// area-code table can ever be right about a lead there — Mountain is only the
// answer that is wrong about fewer people (~400,362 live north of the Salmon
// River against ~1.55M south of it), not an answer that is right.
//
// The city does separate them, and CSV imports already carry one next to the
// state. It is the only signal we hold that can.
//
// ⚠️ This table is safe ONLY because it is additive: a city that is not listed
// falls straight through to the state default, which is exactly today's
// behaviour. So an omission costs nothing and a WRONG entry costs everything —
// it would still produce a timezone, and still look resolved. Every city below
// was checked to its county, and two candidates were dropped for failing that:
//
//   • "Shoshone" is the seat of LINCOLN county in south-central Idaho and
//     observes MOUNTAIN. It shares a name with northern Shoshone County, so a
//     list of that county's cities reports it as northern. It is not.
//   • Idaho County is split by the Salmon River — 49 CFR 71.9(a) draws the
//     Pacific boundary along it — so Grangeville, Riggins, Kamiah and the rest
//     are left out rather than guessed at.
//
// Authored as readable names and normalised at load, so the literal stays
// checkable by eye and nobody has to hand-write a normalised key.
const NORTH_IDAHO_PACIFIC = [
  // Kootenai County
  "Coeur d'Alene",
  "Post Falls",
  "Hayden",
  "Hayden Lake",
  "Rathdrum",
  "Dalton Gardens",
  "Spirit Lake",
  "Hauser",
  "Athol",
  // Nez Perce County
  "Lewiston",
  "Lapwai",
  "Culdesac",
  // Latah County
  "Moscow",
  "Genesee",
  "Troy",
  "Potlatch",
  "Juliaetta",
  "Deary",
  // Bonner County
  "Sandpoint",
  "Priest River",
  "Ponderay",
  "Kootenai",
  "Dover",
  "Clark Fork",
  // Boundary County
  "Bonners Ferry",
  "Moyie Springs",
  // Benewah County
  "St. Maries",
  "Saint Maries", // same place; CSVs spell it both ways
  "Plummer",
  // Shoshone County (the COUNTY — see the note about the city above)
  "Kellogg",
  "Pinehurst",
  "Osburn",
  "Wallace",
  "Smelterville",
  "Mullan",
  // Clearwater County
  "Orofino",
  "Pierce",
  "Weippe",
  // Lewis County
  "Craigmont",
  "Nezperce",
];

/** Fold a free-text city to a comparison key. CSVs spell Coeur d'Alene at
 *  least four ways — straight apostrophe, curly apostrophe, a space, nothing —
 *  so every non-alphanumeric character is dropped rather than normalised. */
function normalizeCity(city: string): string {
  return city.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Nebraska, South Dakota and North Dakota have the same defect as Idaho: 308,
// 605 and 701 each span two zones with no second code on the other side of the
// line. These three default to CENTRAL, so unlike Idaho the tables below list
// the MOUNTAIN minority — the same additive rule, pointing the other way.

// 49 CFR 71.7(c) runs the line along the west boundaries of Thomas, McPherson,
// Keith, Lincoln, Hayes and Hitchcock, so the eighteen counties beyond it are
// Mountain. The regulation's path reads least clearly around Keith, Chase and
// Hooker, so those were checked directly: Ogallala, Imperial and Mullen all
// state Mountain. Note North Platte is NOT here — the line runs along Lincoln
// County's west edge, leaving it Central.
const WESTERN_NEBRASKA_MOUNTAIN = [
  // Scotts Bluff
  "Scottsbluff",
  "Gering",
  "Mitchell", // NB: South Dakota's Mitchell is Central. Hence the state key.
  "Terrytown",
  "Minatare",
  "Morrill", // the village in Scotts Bluff; Morrill is also a county
  "Lyman",
  "Henry",
  "Melbeta",
  // Box Butte / Dawes / Sheridan / Sioux
  "Alliance",
  "Hemingford",
  "Chadron",
  "Crawford",
  "Gordon",
  "Rushville",
  "Harrison",
  // Morrill / Garden
  "Bridgeport",
  "Bayard",
  "Oshkosh",
  "Lewellen",
  // Sandhills: Grant / Hooker / Arthur
  "Hyannis",
  "Mullen",
  "Arthur",
  // Kimball / Cheyenne / Deuel
  "Kimball",
  "Dix",
  "Bushnell",
  "Sidney",
  "Potter",
  "Lodgepole",
  "Dalton",
  "Gurley",
  "Chappell",
  "Big Springs",
  // Keith / Perkins / Chase / Dundy
  "Ogallala",
  "Paxton",
  "Brule",
  "Grant", // the city is in Perkins county; Grant is also a county
  "Madrid",
  "Venango",
  "Imperial",
  "Wauneta",
  "Benkelman",
  "Haigler",
];

// 49 CFR 71.7(b) follows the Missouri's main channel south to Pierre, then the
// west boundaries of Jones, Mellette and Todd — so those three, and everything
// east of the river, stay Central.
//
// ⚠️ Fort Pierre is deliberately absent. It is de jure Mountain (Stanley
// County, west bank) but "most residents of the city use Central Time because
// of close social and economic ties with Pierre". Calling hours care about the
// clock people actually keep, and omitting it yields Central.
const WEST_RIVER_SOUTH_DAKOTA_MOUNTAIN = [
  // Pennington / Lawrence / Meade — the Black Hills
  "Rapid City",
  "Hill City",
  "Wall",
  "Keystone",
  "New Underwood",
  "Quinn",
  "Wasta",
  "Spearfish",
  "Lead",
  "Deadwood",
  "Whitewood",
  "Central City", // in the mountain zone, whatever the name suggests
  "Box Elder",
  "Sturgis",
  "Summerset",
  "Piedmont",
  "Faith",
  // Butte / Fall River / Custer
  "Belle Fourche",
  "Newell",
  "Nisland",
  "Hot Springs",
  "Edgemont",
  "Oelrichs",
  "Custer",
  "Hermosa",
  "Pringle",
  "Buffalo Gap",
  "Fairburn",
  // Haakon / Harding / Jackson
  "Philip",
  "Midland",
  "Buffalo",
  "Camp Crook",
  "Kadoka",
  "Interior",
  "Belvidere",
  // Perkins / Dewey / Ziebach / Corson
  "Lemmon",
  "Bison",
  "Eagle Butte",
  "Timber Lake",
  "Isabel",
  "Dupree",
  "McLaughlin",
  "McIntosh",
  "Morristown",
];

// The eight North Dakota counties lying WHOLLY in the mountain zone: Adams,
// Billings, Bowman, Golden Valley, Grant, Hettinger, Slope, Stark. McKenzie,
// Dunn and Sioux are split, and 49 CFR 71.7(a) draws the line through Mercer
// and Morton, so all five are left out rather than guessed at — which is why
// Mandan, Killdeer, Watford City, Fort Yates and Beulah are absent.
const SOUTHWEST_NORTH_DAKOTA_MOUNTAIN = [
  // Stark
  "Dickinson",
  "Belfield",
  "Richardton",
  "Gladstone",
  "South Heart",
  "Taylor",
  // Bowman / Slope / Billings / Golden Valley
  "Bowman",
  "Scranton",
  "Rhame",
  "Gascoyne",
  "Marmarth",
  "Amidon",
  "Medora",
  "Beach",
  "Golva",
  "Sentinel Butte",
  // Adams — the CITY of Hettinger is here; Hettinger is also a county
  "Hettinger",
  "Reeder",
  "Haynes",
  "Bucyrus",
  // Hettinger county
  "New England",
  "Mott",
  "Regent",
  // Grant
  "Elgin",
  "Carson",
  "New Leipzig",
  "Leith",
];

/** Key a city list to one zone. */
function zoneByCity(cities: string[], zone: string): Record<string, string> {
  return Object.fromEntries(cities.map((city) => [normalizeCity(city), zone]));
}

const CITY_TIMEZONES: Record<string, Record<string, string>> = {
  ID: zoneByCity(NORTH_IDAHO_PACIFIC, "America/Los_Angeles"),
  NE: zoneByCity(WESTERN_NEBRASKA_MOUNTAIN, "America/Denver"),
  SD: zoneByCity(WEST_RIVER_SOUTH_DAKOTA_MOUNTAIN, "America/Denver"),
  ND: zoneByCity(SOUTHWEST_NORTH_DAKOTA_MOUNTAIN, "America/Denver"),
};

/** US state as a 2-letter code, from a code or a full name. Null for anything
 *  that isn't one of the 50 states or DC — Canadian provinces included. */
function usStateCode(state: string | null | undefined): string | null {
  if (!state) return null;
  const trimmed = state.trim();
  if (!trimmed) return null;
  if (trimmed.length === 2) {
    const up = trimmed.toUpperCase();
    return STATE_TIMEZONES[up] ? up : null;
  }
  return STATE_NAME_TO_CODE[trimmed.toLowerCase()] ?? null;
}

/** IANA timezone for a lead's city, but only in states where the area code
 *  cannot tell the two halves apart (ID, NE, SD, ND). Null everywhere else, and
 *  null for an unrecognised city, so the caller keeps whatever the area code
 *  or the state already gave it. Pure. */
export function cityToTimezone(
  city: string | null | undefined,
  state: string | null | undefined,
): string | null {
  const code = usStateCode(state);
  if (!code || !city) return null;
  const table = CITY_TIMEZONES[code];
  if (!table) return null;
  return table[normalizeCity(city)] ?? null;
}

/** Extract the 3-digit area code from a US/CA phone in any format
 *  ("(205) 259-8928", "2052598928", "+12052598928"). Returns null when the
 *  value isn't a 10-digit NANP number. */
function areaCodeOf(phone: string | null | undefined): string | null {
  if (!phone) return null;
  let digits = phone.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (digits.length < 10) return null;
  return digits.slice(0, 3);
}

/** Best-effort US state (2-letter) inferred from a phone number's area code. */
export function stateFromPhone(
  phone: string | null | undefined,
): string | null {
  const ac = areaCodeOf(phone);
  return stateForAreaCode(ac);
}

/** Best-effort IANA timezone from a phone number's area code — the fallback
 *  when a lead has no state. Resolves the area code directly first so that
 *  split-state codes (e.g. 915 El Paso -> America/Denver, 850 Pensacola ->
 *  America/Chicago) get the right zone; falls back to the area code's state
 *  timezone for every code not in the override table. */
export function phoneToTimezone(
  phone: string | null | undefined,
): string | null {
  const ac = areaCodeOf(phone);
  if (!ac) return null;
  if (AREA_CODE_TO_TIMEZONE[ac]) return AREA_CODE_TO_TIMEZONE[ac];
  if (CA_AREA_CODE_TO_TIMEZONE[ac]) return CA_AREA_CODE_TO_TIMEZONE[ac];
  return stateToTimezone(stateForAreaCode(ac));
}

/** The zone an area code pins DIRECTLY — the split-state overrides and the
 *  Canadian table — without falling back to its state's default. Null when the
 *  code carries no more information than its state already does, which is the
 *  case for the great majority of them. Pure. */
function areaCodeZoneOverride(phone: string | null | undefined): string | null {
  const ac = areaCodeOf(phone);
  if (!ac) return null;
  return AREA_CODE_TO_TIMEZONE[ac] ?? CA_AREA_CODE_TO_TIMEZONE[ac] ?? null;
}

/** The timezone an imported lead should carry, from whatever the CSV gave us.
 *
 *  Precedence is most-specific-first:
 *    1. the CITY, but only in a state whose area codes cannot split it —
 *       Idaho, Nebraska, South Dakota and North Dakota, whose 208/986, 308,
 *       605 and 701 have no second code on the far side of the line;
 *    2. the area code's OVERRIDE, when the phone and any stated state agree on
 *       which state we are in (see below);
 *    3. an explicit STATE;
 *    4. the PHONE, which also tells us the state when the CSV had no state
 *       column.
 *
 *  Step 2 is the subtle one. An explicit state normally outranks an area code,
 *  because people keep their numbers when they move — a New York business with
 *  a 213 number is in New York. But an override is not the area code merely
 *  repeating the state: it is SUB-state information the state column cannot
 *  hold. 915 means "the El Paso part of Texas", and "TX" alone can never say
 *  that. So an override outranks the state DEFAULT, gated on the two agreeing
 *  about the state — which is exactly what makes 213 stay silent for a New
 *  York lead while 915 speaks up for a Texan one.
 *
 *  Until this gate existed a stated state short-circuited everything, so the
 *  whole override table only ever fired for state-LESS imports — the rarer
 *  case, and not the one it was written for.
 *
 *  Lifted out of import-actions.ts, where it was inline and untested. Pure. */
export function leadTimezoneFrom({
  city,
  state,
  phone,
}: {
  city?: string | null;
  state?: string | null;
  phone?: string | null;
}): string | null {
  const hasState = typeof state === "string" && state.trim().length > 0;
  // The city table is keyed by state, so when the CSV omitted the state we
  // still need one — the area code gives it, which is how a city-only-plus-
  // phone row still reaches north Idaho.
  const forCity = hasState ? state : stateFromPhone(phone);
  const byCity = cityToTimezone(city, forCity);
  if (byCity) return byCity;

  // A Canadian province resolves to null here, which is deliberate: it lets a
  // Canadian area code's zone through on the same branch as a state-less lead,
  // since no US state can contradict it.
  const statedCode = usStateCode(state);
  if (!statedCode || statedCode === stateFromPhone(phone)) {
    const override = areaCodeZoneOverride(phone);
    if (override) return override;
  }

  if (hasState) return stateToTimezone(state);
  return phoneToTimezone(phone);
}
