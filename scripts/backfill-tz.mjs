import fs from "node:fs";

const env = Object.fromEntries(
  fs
    .readFileSync(".env.local", "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);
const S = env.NEXT_PUBLIC_SUPABASE_URL;
const K = env.SUPABASE_SERVICE_ROLE_KEY;
const hGet = { apikey: K, Authorization: `Bearer ${K}` };
const hWrite = { ...hGet, "Content-Type": "application/json" };

const STATE_TIMEZONES = {
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
const STATE_AREA_CODES = {
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
const AC2STATE = {};
for (const [st, codes] of Object.entries(STATE_AREA_CODES))
  for (const c of codes) AC2STATE[c] = st;

function stateTz(state) {
  if (!state) return null;
  const t = String(state).trim();
  if (t.length === 2) return STATE_TIMEZONES[t.toUpperCase()] ?? null;
  return null;
}
function stateFromPhone(phone) {
  if (!phone) return null;
  let d = String(phone).replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  if (d.length < 10) return null;
  return AC2STATE[d.slice(0, 3)] ?? null;
}

let from = 0,
  PAGE = 1000,
  tzSet = 0,
  stateSet = 0,
  scanned = 0,
  noMatch = 0;
for (;;) {
  const rows = await (
    await fetch(
      S +
        `/rest/v1/leads?select=id,state,business_phone,timezone&timezone=is.null&deleted_at=is.null&order=id.asc&offset=${from}&limit=${PAGE}`,
      { headers: hGet },
    )
  ).json();
  if (!Array.isArray(rows) || rows.length === 0) break;
  scanned += rows.length;
  for (const lead of rows) {
    let tz = stateTz(lead.state);
    const patch = {};
    if (!tz) {
      const st = stateFromPhone(lead.business_phone);
      if (st) {
        tz = stateTz(st);
        if (!lead.state) {
          patch.state = st;
          stateSet++;
        }
      }
    }
    if (!tz) {
      noMatch++;
      continue;
    }
    patch.timezone = tz;
    tzSet++;
    await fetch(S + "/rest/v1/leads?id=eq." + lead.id, {
      method: "PATCH",
      headers: hWrite,
      body: JSON.stringify(patch),
    });
  }
  if (rows.length < PAGE) break;
  from += PAGE;
}
console.log(
  `Scanned ${scanned} | timezone set ${tzSet} | state set ${stateSet} | no area-code match ${noMatch}`,
);
