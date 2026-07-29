import {
  PROVINCE_AREA_CODES,
  regionForAreaCode,
  STATE_AREA_CODES,
} from "./nanp-states";

/**
 * Metro groupings of NANP area codes — the codes that a local recipient reads as
 * "someone near me", which is finer-grained than the state.
 *
 * This exists because same-state is too coarse a fallback on its own. Florida
 * spans Miami and Pensacola, 650 miles apart: a 850 caller ID is technically
 * "local" to a 305 lead and obviously isn't. Grouping 305/786/954/754/561 as
 * South Florida fixes that, and matches the rule this was built for — if the
 * lead's own area code has no numbers left to buy, take a neighbour in the same
 * city before anything else in the state.
 *
 * Groups are overlays plus genuinely adjacent suburban codes, not whole
 * commuting regions — the test is whether the number reads as local to someone
 * living there. Codes absent from every group simply have no metro peers and
 * fall through to the same state/province tier.
 *
 * Canadian metros are included: this platform dials Canadian leads and buys
 * Canadian numbers for them.
 */
export const METRO_AREA_CODES: readonly (readonly string[])[] = [
  // ---- United States -----------------------------------------------------
  // New York / Long Island / lower Hudson
  ["212", "646", "332", "917", "718", "347", "929", "516", "631", "914"],
  ["201", "551", "862", "973", "908", "732", "848"], // northern + central NJ
  ["213", "323", "310", "424", "818", "747", "626", "562"], // Los Angeles
  ["714", "657", "949", "909", "951"], // Orange County / Inland Empire
  ["312", "773", "872", "847", "224", "630", "331", "708", "464"], // Chicago
  ["214", "469", "972", "945", "817", "682"], // Dallas–Fort Worth
  ["713", "281", "832", "346"], // Houston
  ["305", "786", "954", "754", "561"], // South Florida
  ["215", "267", "445", "610", "484"], // Philadelphia
  ["404", "678", "470", "770", "943"], // Atlanta
  ["602", "480", "623", "520"], // Phoenix / Tucson corridor
  ["617", "857", "781", "339", "978", "351"], // Boston
  ["415", "628", "510", "341", "650", "669", "408", "925"], // SF Bay Area
  ["313", "248", "947", "734", "586"], // Detroit
  ["206", "425", "253", "564"], // Seattle
  ["612", "651", "763", "952"], // Minneapolis–St. Paul
  ["619", "858", "760", "442"], // San Diego
  ["303", "720", "983"], // Denver
  ["202", "703", "571", "240", "301"], // Washington DC metro
  ["813", "727", "656"], // Tampa–St. Petersburg
  ["407", "321", "689"], // Orlando
  ["314", "636", "557"], // St. Louis
  ["410", "443", "667"], // Baltimore
  ["503", "971"], // Portland OR
  ["702", "725"], // Las Vegas
  ["704", "980"], // Charlotte
  ["216", "440"], // Cleveland
  ["412", "878"], // Pittsburgh
  ["916", "279"], // Sacramento
  ["512", "737"], // Austin
  ["210", "726"], // San Antonio
  ["615", "629"], // Nashville
  ["614", "380"], // Columbus
  ["317", "463"], // Indianapolis
  ["816", "913"], // Kansas City (straddles MO/KS)
  ["414", "274"], // Milwaukee
  ["801", "385"], // Salt Lake City
  ["919", "984"], // Raleigh–Durham
  ["804", "686"], // Richmond
  ["860", "959"], // Hartford
  ["405", "572"], // Oklahoma City
  ["205", "659"], // Birmingham
  ["402", "531"], // Omaha
  ["901"], // Memphis
  ["502"], // Louisville
  // ---- Canada ------------------------------------------------------------
  ["416", "647", "437", "905", "289", "365", "742"], // Greater Toronto
  ["604", "778", "236", "672"], // Metro Vancouver
  ["403", "587", "825", "368"], // Calgary
  ["780", "587", "825"], // Edmonton
  ["514", "438", "450", "579"], // Montreal
  ["613", "343"], // Ottawa
  ["902", "782"], // Nova Scotia / PEI
  ["506"], // New Brunswick
];

/** area code -> the other codes in its metro, precomputed at module load. */
const METRO_PEERS: Record<string, string[]> = (() => {
  const map: Record<string, Set<string>> = {};
  for (const group of METRO_AREA_CODES) {
    for (const code of group) {
      map[code] ??= new Set<string>();
      for (const other of group) if (other !== code) map[code].add(other);
    }
  }
  return Object.fromEntries(
    Object.entries(map).map(([code, peers]) => [code, [...peers]]),
  );
})();

/** The other area codes serving the same metro as `areaCode`, or an empty array
 *  when it has no metro peers. Pure. */
export function metroPeers(areaCode: string | null | undefined): string[] {
  if (!areaCode) return [];
  return METRO_PEERS[areaCode] ?? [];
}

/**
 * Where to look next when `areaCode` itself can't supply a number — nearest
 * first: the rest of its metro, then the rest of its state or province.
 *
 * `areaCode` itself is never included (the caller has already tried it), and no
 * code repeats. An unknown or non-geographic code yields an empty list rather
 * than a nationwide scattergun: buying a random out-of-state number is exactly
 * the robocall pattern local presence exists to avoid, so the caller should
 * report "none available" instead.
 *
 * Pure — the caller does the searching.
 */
export function siblingAreaCodes(
  areaCode: string | null | undefined,
): string[] {
  if (!areaCode) return [];
  const seen = new Set<string>([areaCode]);
  const out: string[] = [];

  for (const peer of metroPeers(areaCode)) {
    if (!seen.has(peer)) {
      seen.add(peer);
      out.push(peer);
    }
  }

  const region = regionForAreaCode(areaCode);
  if (region) {
    const inRegion =
      STATE_AREA_CODES[region] ?? PROVINCE_AREA_CODES[region] ?? [];
    for (const code of inRegion) {
      if (!seen.has(code)) {
        seen.add(code);
        out.push(code);
      }
    }
  }

  return out;
}
