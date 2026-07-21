import { config } from "dotenv";
import { describe, expect, it } from "vitest";

// Real credentials. ES imports are hoisted above this call, so the module under
// test is imported dynamically inside the test rather than at the top — that
// way the key is definitely in process.env before anything reads it.
config({ path: ".env.local", quiet: true });

/**
 * OPT-IN live check — skipped unless RESEARCH_LIVE=1.
 *
 * This is the only way to judge whether the research is actually good enough to
 * role-play a stranger's front desk, and it needs no phone call, no agent and
 * no deploy. It prints the brief it got so a human can read it.
 *
 *   RESEARCH_LIVE=1 npx vitest run tests/business-research-live.unit.test.ts \
 *     --disableConsoleIntercept
 *
 * The --disableConsoleIntercept flag matters: without it vitest swallows the
 * console output and you see a green tick but none of the brief.
 *
 * Override the target with env vars:
 *   RESEARCH_COMPANY, RESEARCH_CITY, RESEARCH_STATE, RESEARCH_WEBSITE
 *
 * It deliberately does NOT assert `found === true`: an honest "I couldn't
 * identify them" is a correct outcome for a business with no web presence, and
 * failing the run for that would train us to ignore it.
 */
const live = process.env.RESEARCH_LIVE === "1";

describe.skipIf(!live)("researchBusiness — LIVE", () => {
  it("returns a complete, speakable brief for a real business", async () => {
    const { researchBusiness } =
      await import("../src/lib/openai/business-research");

    const inputs = {
      company: process.env.RESEARCH_COMPANY ?? "Referrizer",
      city: process.env.RESEARCH_CITY ?? "Fort Lauderdale",
      state: process.env.RESEARCH_STATE ?? "FL",
      website: process.env.RESEARCH_WEBSITE ?? null,
      heardOnCall: null,
    };

    const started = Date.now();
    const brief = await researchBusiness(inputs);
    const tookMs = Date.now() - started;

    console.log(
      `\n--- researchBusiness (${tookMs}ms) ---\n` +
        `${JSON.stringify(inputs)}\n` +
        `${JSON.stringify(brief, null, 2)}\n`,
    );

    // Shape only: every field present and usable, whatever research found.
    expect(typeof brief.found).toBe("boolean");
    expect(brief.business_name_spoken.length).toBeGreaterThan(0);
    expect(brief.receptionist_greeting.length).toBeGreaterThan(0);
    expect(Array.isArray(brief.services)).toBe(true);
    expect(brief.common_caller_reasons.length).toBeGreaterThan(0);
    expect(Array.isArray(brief.do_not_claim)).toBe(true);

    // Must stay inside the tool's own 25s ElevenLabs timeout, or the agent is
    // left hanging mid-call. Measured range is ~6-13s.
    expect(tookMs).toBeLessThan(25_000);
  }, 30_000);
});
