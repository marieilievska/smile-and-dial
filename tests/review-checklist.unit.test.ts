import { describe, expect, it } from "vitest";

import { shapeChecklist, type ChecklistDef } from "../src/lib/review/buckets";

const def = (key: string, active: boolean): ChecklistDef => ({
  key,
  label: key,
  lens: "quality",
  severity: 2,
  guidance: `check ${key}`,
  active,
});

describe("shapeChecklist", () => {
  it("tallies confirmed/rejected per flag and keeps active first", () => {
    const defs = [def("tool_error", true), def("old_flag", false)];
    const rows = [
      { flag_key: "tool_error", status: "confirmed" },
      { flag_key: "tool_error", status: "rejected" },
      { flag_key: "tool_error", status: "confirmed" },
      { flag_key: "old_flag", status: "rejected" },
      { flag_key: "gone", status: "confirmed" }, // no def → ignored
    ];
    const out = shapeChecklist(defs, rows);
    expect(out.map((f) => f.key)).toEqual(["tool_error", "old_flag"]);
    expect(out[0]).toMatchObject({ active: true, confirmed: 2, rejected: 1 });
    expect(out[1]).toMatchObject({ active: false, confirmed: 0, rejected: 1 });
  });
  it("returns zero tallies when a flag has no history", () => {
    expect(shapeChecklist([def("x", true)], [])[0]).toMatchObject({
      confirmed: 0,
      rejected: 0,
    });
  });
});
