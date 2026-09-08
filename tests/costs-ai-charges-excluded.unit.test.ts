import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

/**
 * The Costs page answers one question: what does DIALLING cost.
 *
 * The `ai_charges` ledger (Ask Smile, agent drafting, template splitting,
 * script tidy-ups, demo business research, ElevenLabs test calls) is admin
 * tooling someone used at a desk. It used to be folded into the OpenAI vendor
 * line and the headline total, which moved both for reasons unrelated to
 * calling — on 2026-09-08 the page reported spend on a day with ZERO calls
 * behind it, from a single $0.0261 template split.
 *
 * These guard the separation. They read source text rather than render the
 * page because the numbers involved are composed in a Server Component that
 * needs a live Supabase client; the arithmetic here is addition, and what
 * actually regresses is someone adding the term back.
 */
const PAGE = readFileSync("src/app/(app)/costs/page.tsx", "utf8");
const VENDOR = readFileSync(
  "src/app/(app)/costs/costs-vendor-breakdown.tsx",
  "utf8",
);
const OTHER_AI = readFileSync("src/app/(app)/costs/costs-other-ai.tsx", "utf8");

/** Source with `//` and `/* *\/` comments stripped, so prose explaining the
 *  rule can never satisfy a test asserting the rule. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("ai_charges stays out of the Costs page totals", () => {
  it("is not added to the headline period total", () => {
    const body = code(PAGE);
    const line = /const periodTotal\s*=\s*([^;]+);/.exec(body)?.[1] ?? "";
    expect(line).not.toContain("aiCharges");
    // The terms that SHOULD be there, so this fails loudly if the whole
    // expression is refactored away rather than silently passing on an empty
    // match.
    expect(line).toContain("summary.total");
    expect(line).toContain("numberRentalInPeriod");
    expect(line).toContain("importLookupCost");
  });

  it("is not added to the prior-period total either", () => {
    // A delta computed over a different set of costs than the figure it sits
    // under would be worse than no delta at all.
    const body = code(PAGE);
    const line = /const prevPeriodTotal\s*=\s*([^;]+);/.exec(body)?.[1] ?? "";
    expect(line).not.toContain("AiCharges");
    expect(line).toContain("prevTotal");
    expect(line).toContain("prevImportLookupCost");
  });

  it("is not passed into the vendor breakdown", () => {
    expect(code(PAGE)).not.toContain("extraOpenAiCost");
    expect(code(VENDOR)).not.toContain("extraOpenAiCost");
  });

  it("leaves the OpenAI vendor line as call-attributable spend only", () => {
    const body = code(VENDOR);
    // The OpenAI row's value, whatever else moves around it.
    expect(body).toMatch(/value:\s*summary\.openai\s*,/);
    expect(body).not.toMatch(/value:\s*summary\.openai\s*\+/);
  });

  it("keeps the vendor bar summing to its own vendor rows", () => {
    const body = code(VENDOR);
    const line = /const vendorTotal\s*=\s*([^;]+);/.exec(body)?.[1] ?? "";
    expect(line).toContain("summary.total");
    expect(line).toContain("extraLookupCost");
    expect(line).not.toContain("OpenAi");
  });

  it("still fetches the ledger once, for the table", () => {
    // The spend must stay VISIBLE — it is only barred from the totals. And
    // only one fetch: nothing compares it to a prior window any more.
    const body = code(PAGE);
    expect(body).toContain("fetchAiChargeTotals");
    expect(body.match(/fetchAiChargeTotals\(/g)).toHaveLength(1);
    expect(body).toContain("aiCharges.byKind");
  });

  it("tells the reader the table is outside the totals", () => {
    // The old caption said "Included in the OpenAI line and the total above".
    // If the numbers change and the caption does not, the page lies.
    expect(OTHER_AI).not.toContain("Included in the OpenAI line");
    expect(OTHER_AI).toMatch(/not counted in any total/i);
  });
});
