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
