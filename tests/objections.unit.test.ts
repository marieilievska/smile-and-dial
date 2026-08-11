import { describe, expect, test } from "vitest";

import {
  computeObjectionBreakdown,
  type ObjectionRow,
} from "@/lib/agent-analytics/objections";

const row = (p: Partial<ObjectionRow>): ObjectionRow => ({
  leadId: "L",
  company: "Acme",
  category: null,
  specific: null,
  quote: null,
  ...p,
});

describe("computeObjectionBreakdown", () => {
  test("counts by category and keeps quote samples, most-common first", () => {
    const r = computeObjectionBreakdown([
      row({
        category: "price",
        specific: "too pricey",
        quote: "way too expensive",
      }),
      row({
        category: "price",
        specific: "budget",
        quote: "no budget this year",
      }),
      row({
        category: "already_have_solution",
        specific: "Podium",
        quote: "we use Podium",
      }),
    ]);
    expect(r.total).toBe(3);
    expect(r.byCategory[0]).toMatchObject({ category: "price", count: 2 });
    expect(r.byCategory[1]).toMatchObject({
      category: "already_have_solution",
      count: 1,
    });
    expect(r.byCategory[0].samples[0].quote).toBeTruthy();
  });

  test("rows with no category are ignored", () => {
    const r = computeObjectionBreakdown([
      row({}),
      row({ category: "no_need" }),
    ]);
    expect(r.total).toBe(1);
  });
});
