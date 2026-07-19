import { describe, it, expect } from "vitest";
import { buildPoolPlan } from "../src/lib/dialer/pool-plan";

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
