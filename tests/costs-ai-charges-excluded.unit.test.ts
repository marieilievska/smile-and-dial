import { readFileSync, readdirSync } from "node:fs";
import { describe, it, expect } from "vitest";

/**
 * The Costs page answers one question: what does DIALLING cost.
 *
 * The `ai_charges` ledger (Ask Smile, agent drafting, template splitting,
 * script tidy-ups, demo business research, ElevenLabs test calls) is admin
 * tooling someone used at a desk. It is recorded — `recordAiCharge` has six
 * live callers — but it does not belong on this page in any form.
 *
 * It got here in two steps. First it was folded into the OpenAI vendor line
 * and the headline total, which moved both for reasons unrelated to calling:
 * on 2026-09-08 the page reported spend on a day with ZERO calls behind it,
 * off a single $0.0261 template split. Removing it from the totals left an
 * "Other AI usage" table, and that went too — a number nobody should act on
 * is not improved by being shown in its own box.
 *
 * These read source text rather than render the page, because the page is a
 * Server Component needing a live Supabase client. What actually regresses is
 * someone wiring the ledger back in, and that is visible in the source.
 */
const PAGE = readFileSync("src/app/(app)/costs/page.tsx", "utf8");
const VENDOR = readFileSync(
  "src/app/(app)/costs/costs-vendor-breakdown.tsx",
  "utf8",
);
const ANALYTICS_COSTS = readFileSync("src/lib/analytics/costs.ts", "utf8");

/** Source with `//` and block comments stripped, so prose explaining the rule
 *  can never satisfy a test asserting the rule. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("the ai_charges ledger is absent from the Costs page", () => {
  it("is not referenced by the page at all", () => {
    const body = code(PAGE);
    expect(body).not.toContain("aiCharges");
    expect(body).not.toContain("AiCharge");
    expect(body).not.toContain("ai_charges");
    expect(body).not.toContain("CostsOtherAi");
  });

  it("is not read by ANY file behind the Costs page", () => {
    // The version of this guard that only checked three named files MISSED a
    // second query in stats-query.ts, which was still folding the ledger into
    // today's spend, month-to-date and the month-end projection. Naming files
    // is how you get a fix that looks complete and is not; sweep the directory
    // instead.
    const dir = "src/app/(app)/costs";
    const offenders = readdirSync(dir)
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .filter((f) =>
        code(readFileSync(`${dir}/${f}`, "utf8")).includes("ai_charges"),
      );
    expect(offenders).toEqual([]);
  });

  it("has no fetcher left to call", () => {
    // The loader was deleted with the table. Leaving an unused exported
    // fetcher is how a removed feature quietly comes back.
    expect(code(ANALYTICS_COSTS)).not.toContain("fetchAiChargeTotals");
    expect(code(ANALYTICS_COSTS)).not.toContain("AiChargeTotals");
  });

  it("leaves the OpenAI vendor line as call-attributable spend only", () => {
    const body = code(VENDOR);
    expect(body).toMatch(/value:\s*summary\.openai\s*,/);
    expect(body).not.toMatch(/value:\s*summary\.openai\s*\+/);
    expect(body).not.toContain("extraOpenAiCost");
  });

  it("keeps the headline total to calls, rental and lookups", () => {
    const line = /const periodTotal\s*=\s*([^;]+);/.exec(code(PAGE))?.[1] ?? "";
    expect(line).not.toContain("aiCharges");
    // Named so this fails loudly if the expression is refactored away rather
    // than passing on an empty match.
    expect(line).toContain("summary.total");
    expect(line).toContain("numberRentalInPeriod");
    expect(line).toContain("importLookupCost");
  });

  it("keeps the prior-period total in step with it", () => {
    // A delta computed over a different set of costs than the figure it sits
    // under would be worse than no delta at all.
    const line =
      /const prevPeriodTotal\s*=\s*([^;]+);/.exec(code(PAGE))?.[1] ?? "";
    expect(line).not.toContain("AiCharges");
    expect(line).toContain("prevTotal");
    expect(line).toContain("prevImportLookupCost");
  });

  it("keeps the vendor bar summing to its own rows", () => {
    const line =
      /const vendorTotal\s*=\s*([^;]+);/.exec(code(VENDOR))?.[1] ?? "";
    expect(line).toContain("summary.total");
    expect(line).toContain("extraLookupCost");
    expect(line).not.toContain("OpenAi");
  });

  it("still RECORDS the spend — only the display went", () => {
    // Removing the page must not stop the ledger. If this ever fails, the
    // money is being spent and no longer written down anywhere.
    const ledger = readFileSync("src/lib/costs/ai-charges.ts", "utf8");
    expect(ledger).toContain("export async function recordAiCharge");
    expect(ledger).toContain("AI_CHARGE_KINDS");
  });
});
