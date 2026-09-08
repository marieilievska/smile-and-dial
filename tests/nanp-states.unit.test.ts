// tests/nanp-states.unit.test.ts
import { describe, it, expect } from "vitest";
import { stateForAreaCode } from "../src/lib/dialer/nanp-states";

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

describe("the overlay codes added 2026-09-08", () => {
  // An audit of 54,087 live leads found 56 carrying an area code this map did
  // not know. A missing code is not cosmetic: regionForAreaCode returns null,
  // number-pool computes matchTier "none", and the lead is dialled with no
  // local presence even though we hold a number in its state.
  //
  // Every one is an overlay of a code already here, and is asserted against
  // that code rather than against a remembered state — if the overlaid code
  // ever moves, these move with it.
  const OVERLAYS: [added: string, overlays: string][] = [
    ["840", "909"], // CA, Inland Empire
    ["771", "202"], // DC
    ["448", "850"], // FL, Panhandle
    ["656", "727"], // FL, Tampa / St. Pete
    ["728", "985"], // LA
    ["227", "301"], // MD
    ["645", "301"], // MD
    ["557", "314"], // MO
    ["572", "405"], // OK
  ];

  it.each(OVERLAYS)("%s resolves to the same state as %s", (added, base) => {
    expect(stateForAreaCode(base)).not.toBeNull();
    expect(stateForAreaCode(added)).toBe(stateForAreaCode(base));
  });

  it("keeps Puerto Rico out, deliberately", () => {
    // 787/939 are real, but this map's scope is the 50 states + DC and no
    // number is held there, so a PR row would change no match. Documented in
    // 20260908140000 so nobody "fixes" it by accident.
    expect(stateForAreaCode("787")).toBeNull();
    expect(stateForAreaCode("939")).toBeNull();
  });
});

describe("the SQL seed cannot drift from this map", () => {
  // scripts/gen-nanp-seed.mjs exists so SQL and TS can never be hand-edited
  // apart. This asserts the newest seed migration actually carries what the
  // map says -- the drift the generator was written to prevent.
  it("carries every added overlay", async () => {
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync(
      "supabase/migrations/20260908140000_nanp_missing_overlays.sql",
      "utf8",
    );
    for (const [added] of [
      ["840", "CA"],
      ["771", "DC"],
      ["448", "FL"],
      ["656", "FL"],
      ["728", "LA"],
      ["227", "MD"],
      ["645", "MD"],
      ["557", "MO"],
      ["572", "OK"],
    ] as [string, string][]) {
      const state = stateForAreaCode(added);
      expect(sql).toContain(`('${added}', '${state}', 'US')`);
    }
  });
});
