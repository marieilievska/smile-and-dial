import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const CALL_NOW = readFileSync(
  fileURLToPath(new URL("../src/lib/dialer/call-now.ts", import.meta.url)),
  "utf8",
);

/**
 * Call Now places calls itself rather than going through the dialer tick, so it
 * needs its own number selection — and it got missed when numbers moved from
 * `campaigns.twilio_number_id` to the pool. `pre_call_check` only proves the
 * campaign has SOME usable number; the specific one is chosen at placement.
 * That left every manual call failing with "no Twilio number assigned" while
 * autopilot dialled fine. These guard the wiring, which no unit test otherwise
 * covers (an e2e test here would place a real billable call).
 */
describe("Call Now number selection", () => {
  it("picks from the campaign's pool, like the dialer tick does", () => {
    expect(CALL_NOW).toContain("selectPoolNumber");
  });

  it("never falls back to the legacy campaigns.twilio_number_id column", () => {
    expect(CALL_NOW).not.toMatch(/campaign\.twilio_number_id/);
  });

  it("releases the ownership stamp when no pool number is free", () => {
    // Claiming the lead pre-dial then bailing without releasing would strand it
    // as owned by a campaign that never called it.
    const branch = CALL_NOW.slice(
      CALL_NOW.indexOf("if (!picked)"),
      CALL_NOW.indexOf("if (!picked)") + 600,
    );
    expect(branch).toContain("stampedHere");
    expect(branch).toContain("owner_campaign_id: null");
  });
});
