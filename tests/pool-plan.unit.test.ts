import { describe, it, expect } from "vitest";
import { buildPoolPlan, buildStatePlan } from "../src/lib/dialer/pool-plan";
import { regionForAreaCode } from "../src/lib/dialer/nanp-states";

describe("buildPoolPlan", () => {
  it("suggests ceil(leads / (cap*days)) numbers per area, minus what's owned", () => {
    const plan = buildPoolPlan({
      // 954: 500 leads → 500/(100*5)=1 number; 305: 1500 → 3 numbers (owns 1 → 2 more)
      leadAreaCodes: [...Array(500).fill("954"), ...Array(1500).fill("305")],
      ownedByAreaCode: { "305": 1 },
      dailyCap: 100,
      workdays: 5,
    });
    const a305 = plan.find((p) => p.areaCode === "305")!;
    const a954 = plan.find((p) => p.areaCode === "954")!;
    expect(a305).toMatchObject({ leads: 1500, owned: 1, suggested: 2 });
    expect(a954).toMatchObject({ leads: 500, owned: 0, suggested: 1 });
  });

  it("sorts biggest areas first", () => {
    const plan = buildPoolPlan({
      leadAreaCodes: ["212", "305", "305", "305", "954", "954"],
      ownedByAreaCode: {},
      dailyCap: 100,
      workdays: 5,
    });
    expect(plan.map((p) => p.areaCode)).toEqual(["305", "954", "212"]);
  });

  it("suggests 0 when the area is already covered", () => {
    const plan = buildPoolPlan({
      leadAreaCodes: Array(200).fill("754"),
      ownedByAreaCode: { "754": 5 },
      dailyCap: 100,
      workdays: 5,
    });
    expect(plan.find((p) => p.areaCode === "754")?.suggested).toBe(0);
  });

  it("guards against zero cap / zero days (no divide-by-zero)", () => {
    const plan = buildPoolPlan({
      leadAreaCodes: Array(50).fill("415"),
      ownedByAreaCode: {},
      dailyCap: 0,
      workdays: 0,
    });
    expect(plan[0].suggested).toBe(50); // ceil(50 / (1*1))
  });
});

describe("buildStatePlan", () => {
  const regionOf = (ac: string) => regionForAreaCode(ac);

  it("groups by state and buys in the state's densest area code", () => {
    // Florida: 100 leads in 954, 300 in 305 -> buy in 305, the bigger pocket.
    const plan = buildStatePlan({
      leadAreaCodes: [...Array(100).fill("954"), ...Array(300).fill("305")],
      ownedByAreaCode: {},
      regionOf,
      dailyCap: 100,
      workdays: 5,
    });
    expect(plan).toHaveLength(1);
    expect(plan[0].region).toBe("FL");
    expect(plan[0].leads).toBe(400);
    expect(plan[0].areaCode).toBe("305");
    expect(plan[0].areaCodeLeads).toBe(300);
  });

  it("counts numbers owned ANYWHERE in the state against the need", () => {
    // A 954 number already covers a 305 lead via the same-state tier, so it
    // must reduce Florida's suggestion — the whole point of buying by state.
    const plan = buildStatePlan({
      leadAreaCodes: Array(400).fill("305"),
      ownedByAreaCode: { "954": 1 },
      regionOf,
      dailyCap: 100,
      workdays: 5,
    });
    expect(plan[0].owned).toBe(1);
    expect(plan[0].suggested).toBe(0);
  });

  it("orders the biggest states first", () => {
    const plan = buildStatePlan({
      leadAreaCodes: [...Array(50).fill("305"), ...Array(200).fill("213")],
      ownedByAreaCode: {},
      regionOf,
      dailyCap: 100,
      workdays: 5,
    });
    expect(plan.map((p) => p.region)).toEqual(["CA", "FL"]);
  });

  it("ignores non-geographic numbers instead of inventing a region", () => {
    // Toll-free leads have nowhere to be local to.
    const plan = buildStatePlan({
      leadAreaCodes: [...Array(10).fill("800"), ...Array(5).fill("305")],
      ownedByAreaCode: {},
      regionOf,
      dailyCap: 100,
      workdays: 5,
    });
    expect(plan).toHaveLength(1);
    expect(plan[0].region).toBe("FL");
    expect(plan[0].leads).toBe(5);
  });

  it("handles Canadian provinces the same way", () => {
    const plan = buildStatePlan({
      leadAreaCodes: [...Array(30).fill("416"), ...Array(10).fill("905")],
      ownedByAreaCode: {},
      regionOf,
      dailyCap: 100,
      workdays: 5,
    });
    expect(plan[0].region).toBe("ON");
    expect(plan[0].areaCode).toBe("416");
  });
});
