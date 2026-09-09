// tests/nanp-states.unit.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  PROVINCE_AREA_CODES,
  STATE_AREA_CODES,
  provinceForAreaCode,
  stateForAreaCode,
} from "../src/lib/dialer/nanp-states";

/** The seed migration this map must agree with. Bump when a newer one lands. */
const SEED_MIGRATION =
  "supabase/migrations/20260909120000_nanp_nanpa_reconcile.sql";

describe("stateForAreaCode", () => {
  it("maps known geographic area codes to their state", () => {
    expect(stateForAreaCode("954")).toBe("FL");
    expect(stateForAreaCode("754")).toBe("FL");
    expect(stateForAreaCode("212")).toBe("NY");
    expect(stateForAreaCode("305")).toBe("FL");
    expect(stateForAreaCode("415")).toBe("CA");
    expect(stateForAreaCode("312")).toBe("IL");
    expect(stateForAreaCode("202")).toBe("DC");
    expect(stateForAreaCode("617")).toBe("MA");
  });

  it("returns null for unknown / non-geographic codes and null input", () => {
    expect(stateForAreaCode("800")).toBeNull();
    expect(stateForAreaCode("999")).toBeNull();
    expect(stateForAreaCode(null)).toBeNull();
  });
});

describe("overlay codes, as NANPA files them", () => {
  // Each row is [code, the code it overlays, its state] — all three read off
  // the NANPA NPA Database on 2026-09-09 (OVERLAY_COMPLEX / PARENT_NPA_ID /
  // LOCATION).
  //
  // The third column is the whole point. The 2026-09-08 pass asserted only the
  // first two, so "728 is an overlay of 985" passed contentedly while 728 and
  // 985 sat in the wrong state together — a self-consistent lie. The parent
  // keeps a code moving with the one it overlays if that ever changes; the
  // literal state pins the pair to something outside this repo.
  const OVERLAYS: [code: string, overlays: string, state: string][] = [
    // --- added 2026-09-08 ---
    ["840", "909", "CA"],
    ["771", "202", "DC"],
    ["448", "850", "FL"],
    ["656", "727", "FL"],
    ["227", "301", "MD"],
    ["557", "314", "MO"],
    ["572", "405", "OK"],
    // --- corrected 2026-09-09: both were filed outside Florida ---
    ["728", "561", "FL"],
    ["645", "305", "FL"],
    // --- added 2026-09-09 ---
    ["483", "334", "AL"],
    ["659", "205", "AL"],
    ["327", "870", "AR"],
    ["350", "209", "CA"],
    ["357", "559", "CA"],
    ["369", "707", "CA"],
    ["738", "323", "CA"],
    ["837", "530", "CA"],
    ["748", "970", "CO"],
    ["324", "904", "FL"],
    ["861", "309", "IL"],
    ["457", "318", "LA"],
    ["924", "507", "MN"],
    ["235", "573", "MO"],
    ["471", "662", "MS"],
    ["472", "910", "NC"],
    ["465", "718", "NY"],
    ["624", "716", "NY"],
    ["283", "513", "OH"],
    ["326", "937", "OH"],
    ["436", "440", "OH"],
    ["582", "814", "PA"],
    ["835", "484", "PA"],
    ["821", "864", "SC"],
    ["729", "423", "TN"],
    ["621", "346", "TX"],
    ["686", "804", "VA"],
    ["826", "540", "VA"],
    ["948", "757", "VA"],
    ["274", "920", "WI"],
    ["353", "608", "WI"],
  ];

  it.each(OVERLAYS)("%s overlays %s and is in %s", (code, overlaid, state) => {
    expect(stateForAreaCode(code)).toBe(state);
    expect(stateForAreaCode(overlaid)).toBe(state);
  });

  it("puts 728 and 645 in Florida, not Louisiana and Maryland", () => {
    // The regression that motivated the 2026-09-09 reconcile, called out by
    // name because a wrong state is worse than a missing one: it MATCHES, so
    // pickPoolNumber hands a Louisiana number to a Florida lead and records
    // local_match 'state'. The metric reports success; the lead sees an
    // out-of-state caller ID.
    expect(stateForAreaCode("728")).toBe("FL"); // 561 Palm Beach overlay
    expect(stateForAreaCode("645")).toBe("FL"); // 305/786 Miami overlay
    expect(STATE_AREA_CODES.LA).not.toContain("728");
    expect(STATE_AREA_CODES.MD).not.toContain("645");
  });

  it("adds the two live Canadian overlays", () => {
    expect(provinceForAreaCode("257")).toBe("BC"); // 604 Vancouver overlay
    expect(provinceForAreaCode("942")).toBe("ON"); // 416 Toronto overlay
  });
});

describe("codes deliberately left out", () => {
  it("keeps Puerto Rico and the other territories out", () => {
    // Real codes, but this map's scope is the 50 states + DC and we hold no
    // number in any territory, so a row would change no match.
    for (const code of ["787", "939", "340", "670", "671", "684"]) {
      expect(stateForAreaCode(code)).toBeNull();
    }
  });

  it("keeps 922 out: NANPA has it non-geographic and not in service", () => {
    // 922 was seen on live leads and looked like a plausible US overlay, so it
    // was checked on 2026-09-09 along with the ones that were added. NANPA
    // lists it as an Easily Recognizable Code, USE = 'N', never placed in
    // service — there is no state to map it to.
    expect(stateForAreaCode("922")).toBeNull();
    expect(provinceForAreaCode("922")).toBeNull();
  });
});

describe("the SQL seed cannot drift from this map", () => {
  // scripts/gen-nanp-seed.mjs exists so SQL and TS can never be hand-edited
  // apart. Both directions are checked: a code added to TS without rerunning
  // the generator fails, and so does a row left in SQL after TS drops it.
  const sql = readFileSync(SEED_MIGRATION, "utf8");
  const seeded = new Map<string, [state: string, country: string]>();
  for (const m of sql.matchAll(/\('(\d{3})', '([A-Z]{2})', '(US|CA)'\)/g)) {
    seeded.set(m[1], [m[2], m[3]]);
  }

  const expected = new Map<string, [state: string, country: string]>();
  for (const [state, codes] of Object.entries(STATE_AREA_CODES)) {
    for (const c of codes) expected.set(c, [state, "US"]);
  }
  for (const [prov, codes] of Object.entries(PROVINCE_AREA_CODES)) {
    for (const c of codes) expected.set(c, [prov, "CA"]);
  }

  it("seeds a row for every code in the TypeScript map", () => {
    const missing = [...expected.keys()].filter((c) => !seeded.has(c));
    expect(missing).toEqual([]);
  });

  it("seeds no row the TypeScript map does not have", () => {
    const extra = [...seeded.keys()].filter((c) => !expected.has(c));
    expect(extra).toEqual([]);
  });

  it("agrees on the state and country of every code", () => {
    const disagree = [...expected.entries()]
      .filter(([c, [state, country]]) => {
        const row = seeded.get(c);
        return !row || row[0] !== state || row[1] !== country;
      })
      .map(
        ([c, want]) =>
          `${c}: sql=${seeded.get(c)?.join("/")} ts=${want.join("/")}`,
      );
    expect(disagree).toEqual([]);
  });

  it("covers every state and DC", () => {
    expect(Object.keys(STATE_AREA_CODES)).toHaveLength(51);
    for (const codes of Object.values(STATE_AREA_CODES)) {
      expect(codes.length).toBeGreaterThan(0);
    }
  });

  it("never files one area code under two regions", () => {
    const all = [
      ...Object.values(STATE_AREA_CODES).flat(),
      ...Object.values(PROVINCE_AREA_CODES).flat(),
    ];
    expect(all.length).toBe(new Set(all).size);
  });
});
