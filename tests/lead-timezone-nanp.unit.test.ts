// tests/lead-timezone-nanp.unit.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  phoneToTimezone,
  stateFromPhone,
  stateToTimezone,
} from "../src/lib/leads/timezone";
import {
  PROVINCE_AREA_CODES,
  STATE_AREA_CODES,
  stateForAreaCode,
} from "../src/lib/dialer/nanp-states";

/**
 * A lead with no timezone is not skipped — `is_within_calling_hours` does
 * `coalesce(lead_timezone, 'America/New_York')`, and Eastern is the EARLIEST
 * US zone. So an area code this file cannot resolve does not fail safe, it
 * fails EARLY: a California lead falls back to Eastern and a 9am window opens
 * at 6am local, under the 8am floor. That is why these are pinned.
 */

describe("the lead timezone map has one source of truth", () => {
  it("declares no area-code map of its own", () => {
    const src = readFileSync("src/lib/leads/timezone.ts", "utf8");
    expect(src).not.toMatch(/STATE_AREA_CODES\s*:\s*Record/);
  });

  it("agrees with the dialer's NANP map on every US area code", () => {
    for (const [state, codes] of Object.entries(STATE_AREA_CODES)) {
      for (const code of codes) {
        expect(stateFromPhone(`${code}5550123`)).toBe(state);
      }
    }
  });

  it("claims no US state for a code the dialer's map does not have", () => {
    for (let n = 200; n <= 999; n++) {
      const code = String(n);
      expect(stateFromPhone(`${code}5550123`)).toBe(stateForAreaCode(code));
    }
  });

  it("gives every state in the shared map an IANA zone", () => {
    for (const state of Object.keys(STATE_AREA_CODES)) {
      expect(stateToTimezone(state)).toBeTruthy();
    }
  });
});

describe("area codes that used to resolve to no timezone at all", () => {
  // [area code, state, IANA zone] — generated from the NANPA NPA Database
  // (reports.nanpa.com/public/npa_report.csv, file dated 09/09/2026), never
  // hand-transcribed. All 29 were in-service geographic NPAs that the private
  // duplicate map in timezone.ts had never picked up.
  //
  // The state column is the point, per the lesson from #509: asserting a code
  // against the code it supposedly overlays is self-consistent and can be
  // consistently wrong. The literal state pins each row to something outside
  // this repo.
  const NEWLY_RESOLVED: [code: string, state: string, zone: string][] = [
    ["227", "MD", "America/New_York"],
    ["235", "MO", "America/Chicago"],
    ["283", "OH", "America/New_York"],
    ["324", "FL", "America/New_York"],
    ["327", "AR", "America/Chicago"],
    ["329", "NY", "America/New_York"],
    ["353", "WI", "America/Chicago"],
    ["357", "CA", "America/Los_Angeles"],
    ["369", "CA", "America/Los_Angeles"],
    ["436", "OH", "America/New_York"],
    ["448", "FL", "America/Chicago"], // NANPA TIME_ZONE=EC — see below
    ["457", "LA", "America/Chicago"],
    ["465", "NY", "America/New_York"],
    ["471", "MS", "America/Chicago"],
    ["483", "AL", "America/Chicago"],
    ["572", "OK", "America/Chicago"],
    ["621", "TX", "America/Chicago"],
    ["624", "NY", "America/New_York"],
    ["686", "VA", "America/New_York"],
    ["728", "FL", "America/New_York"],
    ["729", "TN", "America/New_York"], // NANPA TIME_ZONE=EC — see below
    ["738", "CA", "America/Los_Angeles"],
    ["748", "CO", "America/Denver"],
    ["771", "DC", "America/New_York"],
    ["821", "SC", "America/New_York"],
    ["837", "CA", "America/Los_Angeles"],
    ["840", "CA", "America/Los_Angeles"],
    ["861", "IL", "America/Chicago"],
    ["924", "MN", "America/Chicago"],
  ];

  it.each(NEWLY_RESOLVED)("%s is in %s, on %s", (code, state, zone) => {
    expect(stateFromPhone(`${code}5550123`)).toBe(state);
    expect(phoneToTimezone(`${code}5550123`)).toBe(zone);
  });

  it("resolves all 29 in every phone format we accept", () => {
    for (const [code, , zone] of NEWLY_RESOLVED) {
      expect(phoneToTimezone(`+1${code}5550123`)).toBe(zone);
      expect(phoneToTimezone(`(${code}) 555-0123`)).toBe(zone);
      expect(phoneToTimezone(`1${code}5550123`)).toBe(zone);
    }
  });
});

describe("the two new codes that land in a split-timezone state", () => {
  // Twenty-seven of the 29 sit in a state with one zone, so the state default
  // is correct for them. These two do not, and taking the state default would
  // have introduced a WRONG timezone — which is worse than the missing one it
  // replaced, because a wrong zone silently succeeds.

  it("puts 448 on Central with the rest of the Florida panhandle", () => {
    // NANPA: 448 is OVERLAY_COMPLEX 448/850, PARENT_NPA_ID 850, TIME_ZONE EC.
    // 850 is Pensacola/Panama City and is already pinned to Central; Florida's
    // state default is Eastern, so 448 needs the same override 850 has.
    expect(stateFromPhone("4485550123")).toBe("FL");
    expect(phoneToTimezone("4485550123")).toBe("America/Chicago");
    expect(phoneToTimezone("4485550123")).toBe(phoneToTimezone("8505550123"));
    expect(phoneToTimezone("4485550123")).not.toBe(stateToTimezone("FL"));
  });

  it("puts 729 on Eastern with the rest of east Tennessee", () => {
    // NANPA: 729 is OVERLAY_COMPLEX 423/729, PARENT_NPA_ID 423, TIME_ZONE EC.
    // 423 is Chattanooga/Knoxville and is already pinned to Eastern;
    // Tennessee's state default is Central, so 729 needs 423's override.
    expect(stateFromPhone("7295550123")).toBe("TN");
    expect(phoneToTimezone("7295550123")).toBe("America/New_York");
    expect(phoneToTimezone("7295550123")).toBe(phoneToTimezone("4235550123"));
    expect(phoneToTimezone("7295550123")).not.toBe(stateToTimezone("TN"));
  });
});

describe("behaviour the single map must not change", () => {
  it("still overrides the split-state codes it always did", () => {
    expect(phoneToTimezone("9155550123")).toBe("America/Denver"); // El Paso
    expect(phoneToTimezone("8505550123")).toBe("America/Chicago"); // panhandle
    expect(phoneToTimezone("2705550123")).toBe("America/Chicago"); // west KY
    expect(phoneToTimezone("2195550123")).toBe("America/Chicago"); // NW Indiana
    expect(phoneToTimezone("4235550123")).toBe("America/New_York"); // east TN
  });

  it("keeps Canada out of the US state lookup but still zones it", () => {
    for (const codes of Object.values(PROVINCE_AREA_CODES)) {
      for (const code of codes) {
        expect(stateFromPhone(`${code}5550123`)).toBeNull();
      }
    }
    expect(phoneToTimezone("4165550123")).toBe("America/New_York"); // Toronto
    expect(phoneToTimezone("6045550123")).toBe("America/Los_Angeles"); // Vancouver
    expect(phoneToTimezone("3065550123")).toBe("America/Regina"); // Saskatchewan
    expect(phoneToTimezone("9025550123")).toBe("America/Halifax"); // Halifax
  });

  it("still resolves nothing for non-geographic and malformed numbers", () => {
    expect(stateFromPhone("8005550123")).toBeNull();
    expect(phoneToTimezone("8005550123")).toBeNull();
    expect(phoneToTimezone("9005550123")).toBeNull();
    expect(phoneToTimezone("555012")).toBeNull();
    expect(phoneToTimezone("")).toBeNull();
    expect(phoneToTimezone(null)).toBeNull();
  });

  it("still prefers an explicit state over the phone's area code", () => {
    expect(stateToTimezone("CA")).toBe("America/Los_Angeles");
    expect(stateToTimezone("california")).toBe("America/Los_Angeles");
    expect(stateToTimezone("Ontario")).toBe("America/New_York");
    expect(stateToTimezone("")).toBeNull();
  });
});

describe("split-state overrides, weighed against where the code actually sits", () => {
  // The override table is a judgement call — "the zone covering most of the
  // code's territory" — so unlike the state map it cannot simply be read off
  // NANPA. These three were checked against 49 CFR 71 (which sets the legal
  // zone boundaries) and county populations, and two of them were backwards.

  it("puts 432 on Central: it is Midland/Odessa, not El Paso", () => {
    // 49 CFR 71.7(e) runs the mountain boundary along the EAST LINE OF
    // HUDSPETH COUNTY, so Texas's mountain zone is El Paso + Hudspeth (plus a
    // sliver of northwest Culberson) — all of it 915 territory. 432 is the
    // Permian Basin: Midland (~180k) and Ector/Odessa (~165k), every county
    // Central. NANPA agrees, marking 915 "CM" and every other Texas code,
    // 432 included, plain "C". The old comment here named the wrong code.
    expect(stateFromPhone("4325550123")).toBe("TX");
    expect(phoneToTimezone("4325550123")).toBe("America/Chicago");
    expect(phoneToTimezone("4325550123")).toBe(stateToTimezone("TX"));
  });

  it("keeps 915 on Mountain: that one really is El Paso", () => {
    expect(phoneToTimezone("9155550123")).toBe("America/Denver");
    expect(phoneToTimezone("9155550123")).not.toBe(stateToTimezone("TX"));
  });

  it("puts 308 on Central, where most of Nebraska's 308 lives", () => {
    // 308 is genuinely split (NANPA "CM"), so this is decided by population.
    // Nebraska's mountain zone is the panhandle: 82,567 across the 13 counties
    // usually counted, 99,488 on the most generous reading. Nine of 308's ~70
    // central-zone counties alone — Hall (Grand Island), Buffalo (Kearney),
    // Adams (Hastings), Lincoln (North Platte), Dawson, Phelps, Red Willow,
    // Custer, Holt — come to 243,499. Central leads by at least 2.4:1.
    expect(stateFromPhone("3085550123")).toBe("NE");
    expect(phoneToTimezone("3085550123")).toBe("America/Chicago");
    expect(phoneToTimezone("3085550123")).toBe(stateToTimezone("NE"));
  });

  it("keeps 986 on Mountain even though NANPA files it Pacific", () => {
    // The one place we knowingly depart from the CSV. NANPA marks 986 "P",
    // but 986 is a STATEWIDE overlay on 208 — and NANPA marks 208 itself "MP".
    // A statewide code cannot touch fewer zones than the code it overlays, so
    // the "P" is a quirk in that column, not a fact about Idaho.
    //
    // Idaho splits at the Salmon River. The ten northern (Pacific) counties
    // total 400,362 — an upper bound, since Idaho County is itself split —
    // while five southern counties alone (Ada 546,141, Canyon, Bonneville,
    // Bannock, Twin Falls) come to 1,146,165. Mountain leads by at least
    // 2.9:1, so both statewide codes stay on Idaho's Mountain default.
    expect(phoneToTimezone("9865550123")).toBe("America/Denver");
    expect(phoneToTimezone("9865550123")).toBe(phoneToTimezone("2085550123"));
    expect(phoneToTimezone("9865550123")).not.toBe("America/Los_Angeles");
  });
});

describe("no override may name a zone its area code never touches", () => {
  // A structural guard, and the one that would have caught 432 mechanically:
  // it was pinned to Mountain while NANPA said the code is Central-only. Every
  // row below is [code, state, NANPA TIME_ZONE, our zone], generated from the
  // NANPA NPA Database (file dated 09/09/2026), not transcribed.
  //
  // This does NOT decide WHICH zone predominates — 308 sat here happily while
  // pointing at the smaller half of Nebraska, because "CM" does contain "M".
  // It only catches a zone the code cannot reach at all.
  //
  // Nor does it require a row to DIFFER from its state's default. Six of these
  // deliberately restate it (458, 541, 605, 620, 701, 906): the table is a
  // record of every straddling code that has been adjudicated, not only the
  // ones whose answer came out different, and "we checked, it stays" is worth
  // writing down.
  const NANPA_ZONES: [code: string, state: string, zones: string][] = [
    ["219", "IN", "EC"],
    ["270", "KY", "EC"],
    ["308", "NE", "CM"],
    ["364", "KY", "EC"],
    ["423", "TN", "EC"],
    ["448", "FL", "EC"],
    ["458", "OR", "MP"],
    ["541", "OR", "MP"],
    ["605", "SD", "CM"],
    ["620", "KS", "CM"],
    ["701", "ND", "CM"],
    ["729", "TN", "EC"],
    ["850", "FL", "EC"],
    ["865", "TN", "E"],
    ["906", "MI", "EC"],
    ["915", "TX", "CM"],
  ];
  const LETTER: Record<string, string> = {
    "America/New_York": "E",
    "America/Chicago": "C",
    "America/Denver": "M",
    "America/Los_Angeles": "P",
  };
  const LETTER_TO_ZONE: Record<string, string> = Object.fromEntries(
    Object.entries(LETTER).map(([zone, letter]) => [letter, zone]),
  );

  /** The override table, read out of the source so a new row cannot slip past
   *  this guard by simply not being listed above. */
  function overriddenCodes(): Record<string, string> {
    const src = readFileSync("src/lib/leads/timezone.ts", "utf8");
    const start = src.indexOf("const AREA_CODE_TO_TIMEZONE");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n};", start));
    return Object.fromEntries(
      [...body.matchAll(/"(\d{3})":\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]),
    );
  }

  it("covers every code the override table actually holds", () => {
    expect(Object.keys(overriddenCodes()).sort()).toEqual(
      NANPA_ZONES.map(([code]) => code).sort(),
    );
  });

  it.each(NANPA_ZONES)(
    "%s (%s) is overridden to a zone inside NANPA's %s",
    (code, state, zones) => {
      const zone = overriddenCodes()[code];
      expect(stateFromPhone(`${code}5550123`)).toBe(state);
      expect(zones).toContain(LETTER[zone]);
    },
  );

  it("holds no code NANPA files as single-zone in a single-zone state", () => {
    // The shape 432 had: a code NANPA marks with ONE zone letter, sitting in a
    // state whose own default is that same zone, yet carrying an override to
    // something else. There is nothing left for such a row to express.
    for (const [, state, zones] of NANPA_ZONES) {
      if (zones.length > 1) continue;
      expect(stateToTimezone(state)).not.toBe(LETTER_TO_ZONE[zones]);
    }
  });
});
