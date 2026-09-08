// tests/nanp-metros.unit.test.ts
import { describe, it, expect } from "vitest";
import {
  METRO_AREA_CODES,
  metroPeers,
  sameRegionAreaCodes,
  siblingAreaCodes,
} from "../src/lib/dialer/nanp-metros";
import { regionForAreaCode } from "../src/lib/dialer/nanp-states";

describe("metroPeers", () => {
  it("groups South Florida together", () => {
    const peers = metroPeers("305");
    expect(peers).toContain("786");
    expect(peers).toContain("954");
    expect(peers).toContain("754");
    expect(peers).not.toContain("305");
  });

  it("is symmetric", () => {
    expect(metroPeers("954")).toContain("305");
  });

  it("returns nothing for a code with no metro group", () => {
    expect(metroPeers("406")).toEqual([]); // Montana, statewide
    expect(metroPeers(null)).toEqual([]);
  });
});

describe("siblingAreaCodes", () => {
  it("puts metro neighbours before the rest of the state", () => {
    // The Miami case: 305 sold out -> try 786/954/754 before Pensacola's 850.
    const sibs = siblingAreaCodes("305");
    const idx = (c: string) => sibs.indexOf(c);
    expect(idx("954")).toBeGreaterThanOrEqual(0);
    expect(idx("850")).toBeGreaterThanOrEqual(0);
    expect(idx("954")).toBeLessThan(idx("850"));
    expect(idx("786")).toBeLessThan(idx("850"));
  });

  it("never includes the input area code", () => {
    expect(siblingAreaCodes("305")).not.toContain("305");
    expect(siblingAreaCodes("406")).not.toContain("406");
  });

  it("has no duplicates", () => {
    const sibs = siblingAreaCodes("213");
    expect(new Set(sibs).size).toBe(sibs.length);
  });

  it("falls back to the state when there is no metro group", () => {
    // 406 is all of Montana and has no metro peers, so siblings are the rest
    // of Montana — which is nothing, since 406 is Montana's only area code.
    expect(siblingAreaCodes("406")).toEqual([]);
    // 208 is Idaho, which also has 986.
    expect(siblingAreaCodes("208")).toContain("986");
  });

  it("stays inside Florida for 305", () => {
    // True of South Florida, but do NOT read it as a general guarantee — this
    // metro simply happens to sit in one state. See the straddle case below;
    // the guarantee lives in `sameRegionAreaCodes`, not here.
    for (const code of siblingAreaCodes("305")) {
      expect(regionForAreaCode(code)).toBe("FL");
    }
  });

  it("can leave the state for a metro that straddles one", () => {
    // Not a defect at this layer: the DC metro genuinely spans DC/VA/MD, and a
    // cross-state metro neighbour is a fine answer to "what else is in this
    // city". It is the wrong answer to "what else can I buy for DC" — 202's
    // peers are ALL out-of-state and DC's own overlay 771 sorts last, so the
    // buy side must narrow this itself (`sameRegionAreaCodes`, used by
    // addNumbersToPool). Pinned so the metro table is not "fixed" instead.
    const sibs = siblingAreaCodes("202");
    expect(sibs).toContain("703"); // Virginia
    expect(sibs).toContain("240"); // Maryland
    expect(sibs.indexOf("703")).toBeLessThan(sibs.indexOf("771"));
  });

  it("works for Canadian area codes and stays in-province", () => {
    const sibs = siblingAreaCodes("416"); // Toronto
    expect(sibs).toContain("647");
    expect(sibs).toContain("905");
    for (const code of sibs) expect(regionForAreaCode(code)).toBe("ON");
  });

  it("returns nothing for toll-free, rather than scattering nationwide", () => {
    // Buying a random out-of-state number is the pattern local presence exists
    // to avoid, so an unknown code must yield no suggestions at all.
    expect(siblingAreaCodes("800")).toEqual([]);
    expect(siblingAreaCodes(null)).toEqual([]);
  });
});

describe("sameRegionAreaCodes", () => {
  it("never leaves DC for Virginia or Maryland", () => {
    // The live case, 2026-09-08: a one-per-state buy asked for DC and Twilio
    // offered +1571…, a second Virginia number. 202's metro peers are all
    // out-of-state (703/571 VA, 240/301 MD) and DC's own overlay 771 sorts
    // last, so an unguarded metro-first fallback buys Virginia.
    const codes = sameRegionAreaCodes("202");
    expect(codes).toEqual(["202", "771"]);
    for (const c of ["703", "571", "240", "301"]) {
      expect(codes).not.toContain(c);
    }
  });

  it("keeps the requested code first", () => {
    expect(sameRegionAreaCodes("305")[0]).toBe("305");
    expect(sameRegionAreaCodes("816")[0]).toBe("816");
  });

  it("never crosses the Kansas City state line", () => {
    // 816 (MO) and 913 (KS) are one metro but two states.
    expect(sameRegionAreaCodes("816")).not.toContain("913");
    expect(sameRegionAreaCodes("913")).not.toContain("816");
  });

  it("still prefers metro neighbours over the far side of the state", () => {
    // The Miami rule survives the region guard: 786/954 before Pensacola's 850.
    const codes = sameRegionAreaCodes("305");
    const idx = (c: string) => codes.indexOf(c);
    expect(idx("786")).toBeLessThan(idx("850"));
    expect(idx("954")).toBeLessThan(idx("850"));
  });

  it("refuses to substitute when the requested code has no known region", () => {
    // 274, 686 and 659 are real overlays missing from the state table, so
    // regionForAreaCode is null for each. Matching on `null === null` would
    // let a Wisconsin request buy a Virginia number — the exact defect this
    // guard exists to prevent. An unknown region substitutes nothing.
    expect(sameRegionAreaCodes("274")).toEqual(["274"]);
    expect(sameRegionAreaCodes("686")).toEqual(["686"]);
    expect(sameRegionAreaCodes("800")).toEqual(["800"]);
  });

  it("returns nothing for a missing area code", () => {
    expect(sameRegionAreaCodes(null)).toEqual([]);
    expect(sameRegionAreaCodes("")).toEqual([]);
  });

  it("stays in-region for every area code in every metro group", () => {
    // The sweep the DC case earns: any future metro edit that straddles a
    // state line is caught here rather than at a Twilio invoice.
    for (const group of METRO_AREA_CODES) {
      for (const code of group) {
        const home = regionForAreaCode(code);
        for (const candidate of sameRegionAreaCodes(code)) {
          if (candidate === code) continue;
          expect(
            regionForAreaCode(candidate),
            `${code} (${home}) offered ${candidate} (${regionForAreaCode(candidate)})`,
          ).toBe(home);
        }
      }
    }
  });
});
