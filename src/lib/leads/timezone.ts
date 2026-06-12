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
// approximation as STATE_TIMEZONES. Authored as state -> codes for legibility;
// flattened to code -> state below. Unknown / Canadian / toll-free codes fall
// through to null and the caller's default timezone.
const STATE_AREA_CODES: Record<string, string[]> = {
  AL: ["205", "251", "256", "334", "659", "938"],
  AK: ["907"],
  AZ: ["480", "520", "602", "623", "928"],
  AR: ["479", "501", "870"],
  CA: [
    "209",
    "213",
    "279",
    "310",
    "323",
    "341",
    "350",
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
    "747",
    "760",
    "805",
    "818",
    "820",
    "831",
    "858",
    "909",
    "916",
    "925",
    "949",
    "951",
  ],
  CO: ["303", "719", "720", "970", "983"],
  CT: ["203", "475", "860", "959"],
  DE: ["302"],
  DC: ["202"],
  FL: [
    "239",
    "305",
    "321",
    "352",
    "386",
    "407",
    "561",
    "645",
    "656",
    "689",
    "727",
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
    "872",
  ],
  IN: ["219", "260", "317", "463", "574", "765", "812", "930"],
  IA: ["319", "515", "563", "641", "712"],
  KS: ["316", "620", "785", "913"],
  KY: ["270", "364", "502", "606", "859"],
  LA: ["225", "318", "337", "504", "985"],
  ME: ["207"],
  MD: ["240", "301", "410", "443", "667"],
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
  MN: ["218", "320", "507", "612", "651", "763", "952"],
  MS: ["228", "601", "662", "769"],
  MO: ["314", "417", "557", "573", "636", "660", "816", "975"],
  MT: ["406"],
  NE: ["308", "402", "531"],
  NV: ["702", "725", "775"],
  NH: ["603"],
  NJ: ["201", "551", "609", "640", "732", "848", "856", "862", "908", "973"],
  NM: ["505", "575"],
  NY: [
    "212",
    "315",
    "332",
    "347",
    "363",
    "516",
    "518",
    "585",
    "607",
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
    "326",
    "330",
    "380",
    "419",
    "440",
    "513",
    "567",
    "614",
    "740",
    "937",
  ],
  OK: ["405", "539", "580", "918"],
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
  SC: ["803", "839", "843", "854", "864"],
  SD: ["605"],
  TN: ["423", "615", "629", "731", "865", "901", "931"],
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
  VA: ["276", "434", "540", "571", "703", "757", "804", "826", "948"],
  WA: ["206", "253", "360", "425", "509", "564"],
  WV: ["304", "681"],
  WI: ["262", "274", "414", "534", "608", "715", "920"],
  WY: ["307"],
};

const AREA_CODE_TO_STATE: Record<string, string> = {};
for (const [state, codes] of Object.entries(STATE_AREA_CODES)) {
  for (const code of codes) AREA_CODE_TO_STATE[code] = state;
}

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
const AREA_CODE_TO_TIMEZONE: Record<string, string> = {
  // Texas — mostly Central; the far west (El Paso, Hudspeth) is Mountain.
  "915": "America/Denver", // El Paso
  "432": "America/Denver", // West Texas: El Paso-region Mountain counties

  // Florida — mostly Eastern; the western panhandle is Central.
  "850": "America/Chicago", // Pensacola / Panama City panhandle

  // Tennessee — East TN is Eastern; Middle/West TN is Central.
  "423": "America/New_York", // Chattanooga / Knoxville region (Eastern)
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

  // Nebraska — eastern Central; the panhandle is Mountain.
  "308": "America/Denver", // western/panhandle Nebraska (Mountain)
  // 402/531 (Omaha/Lincoln) stay Central via the NE state default.

  // Kansas — mostly Central; four far-western counties are Mountain.
  "620": "America/Chicago", // southern/western KS, predominantly Central.

  // Oregon — mostly Pacific; Malheur County (far east) is Mountain.
  "541": "America/Los_Angeles", // statewide-ish, predominantly Pacific.
  "458": "America/Los_Angeles", // overlay on 541, predominantly Pacific.

  // Idaho — north Idaho (incl. 208 panhandle) is Pacific; south is Mountain.
  // The state default is Mountain; the panhandle is the exception, but 208
  // covers the whole state, so leave it on the Mountain state default.
};

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
  return ac ? (AREA_CODE_TO_STATE[ac] ?? null) : null;
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
  return stateToTimezone(AREA_CODE_TO_STATE[ac] ?? null);
}
