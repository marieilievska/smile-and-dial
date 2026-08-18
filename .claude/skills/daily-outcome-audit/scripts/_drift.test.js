const { test } = require("node:test");
const assert = require("node:assert");
const D = require("./_drift");

const day = (date, ratios) => ({ date, ratios });

test("median: odd, even, empty", () => {
  assert.equal(D.median([3, 1, 2]), 2);
  assert.equal(D.median([1, 2, 3, 4]), 2.5);
  assert.equal(D.median([]), null);
});

test("baseline building with <2 prior days", () => {
  const r = D.driftReport({
    today: day("2026-08-12", { not_interested_dm_no: 0.49 }),
    history: [day("2026-08-11", { not_interested_dm_no: 0 })],
  });
  assert.equal(r.baselineBuilding, true);
  assert.equal(r.flags.length, 0);
});

test("flags a big share jump (not_interested_dm_no 0.02 baseline -> 0.49)", () => {
  const hist = [
    day("d1", { not_interested_dm_no: 0.02 }),
    day("d2", { not_interested_dm_no: 0.03 }),
    day("d3", { not_interested_dm_no: 0.01 }),
  ];
  const r = D.driftReport({ today: day("d4", { not_interested_dm_no: 0.49 }), history: hist });
  assert.equal(r.baselineBuilding, false);
  const f = r.flags.find((x) => x.key === "not_interested_dm_no");
  assert.ok(f && f.direction === "up");
});

test("does NOT flag a small share wobble", () => {
  const hist = [day("d1", { callback_share: 0.06 }), day("d2", { callback_share: 0.07 })];
  const r = D.driftReport({ today: day("d3", { callback_share: 0.09 }), history: hist });
  assert.equal(r.flags.find((x) => x.key === "callback_share"), undefined);
});

test("flags a tiny ai_receptionist share jump (0.002 -> 0.017)", () => {
  const hist = [
    day("d1", { ai_receptionist_share: 0.002 }),
    day("d2", { ai_receptionist_share: 0.002 }),
    day("d3", { ai_receptionist_share: 0.003 }),
  ];
  const r = D.driftReport({ today: day("d4", { ai_receptionist_share: 0.017 }), history: hist });
  assert.ok(r.flags.find((x) => x.key === "ai_receptionist_share"));
});

test("flags a count halving (goal_met 21 baseline -> 4) but not on a tiny base", () => {
  const big = D.driftReport({
    today: day("d4", { goal_met: 4 }),
    history: [day("d1", { goal_met: 20 }), day("d2", { goal_met: 22 }), day("d3", { goal_met: 21 })],
  });
  assert.ok(big.flags.find((x) => x.key === "goal_met" && x.direction === "down"));
  const tiny = D.driftReport({
    today: day("d4", { goal_met: 6 }),
    history: [day("d1", { goal_met: 1 }), day("d2", { goal_met: 2 }), day("d3", { goal_met: 1 })],
  });
  assert.equal(tiny.flags.find((x) => x.key === "goal_met"), undefined);
});

test("uses only the last lookback prior days and excludes today's own date", () => {
  const hist = [
    day("2026-08-05", { connect_rate: 0.9 }), // old, outside lookback=5
    day("2026-08-06", { connect_rate: 0.4 }),
    day("2026-08-07", { connect_rate: 0.4 }),
    day("2026-08-08", { connect_rate: 0.4 }),
    day("2026-08-09", { connect_rate: 0.4 }),
    day("2026-08-10", { connect_rate: 0.4 }),
    day("2026-08-11", { connect_rate: 0.41 }),
  ];
  const r = D.driftReport({ today: day("2026-08-11", { connect_rate: 0.41 }), history: hist });
  assert.equal(r.flags.find((x) => x.key === "connect_rate"), undefined);
});
