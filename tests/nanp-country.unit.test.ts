// tests/nanp-country.unit.test.ts
import { describe, it, expect } from "vitest";
import {
  countryForAreaCode,
  stateForAreaCode,
} from "../src/lib/dialer/nanp-states";

describe("countryForAreaCode", () => {
  it("identifies US geographic area codes", () => {
    expect(countryForAreaCode("954")).toBe("US");
    expect(countryForAreaCode("213")).toBe("US");
    expect(countryForAreaCode("732")).toBe("US");
  });

  it("identifies Canadian area codes", () => {
    expect(countryForAreaCode("902")).toBe("CA"); // Nova Scotia
    expect(countryForAreaCode("506")).toBe("CA"); // New Brunswick
    expect(countryForAreaCode("709")).toBe("CA"); // Newfoundland
    expect(countryForAreaCode("403")).toBe("CA"); // Calgary
    expect(countryForAreaCode("905")).toBe("CA"); // Greater Toronto
  });

  it("returns null for toll-free and unknown codes", () => {
    expect(countryForAreaCode("800")).toBeNull();
    expect(countryForAreaCode("888")).toBeNull();
    expect(countryForAreaCode(null)).toBeNull();
    expect(countryForAreaCode("")).toBeNull();
  });

  it("does NOT change stateForAreaCode for Canada in this PR", () => {
    // PR 2 extends this to provinces. Changing it here would alter which
    // number selectPoolNumber picks, which would confound the measurement.
    expect(stateForAreaCode("902")).toBeNull();
  });
});
