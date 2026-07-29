// tests/nanp-metros.unit.test.ts
import { describe, it, expect } from "vitest";
import { metroPeers, siblingAreaCodes } from "../src/lib/dialer/nanp-metros";
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

  it("stays inside the state — never suggests another state", () => {
    for (const code of siblingAreaCodes("305")) {
      expect(regionForAreaCode(code)).toBe("FL");
    }
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
