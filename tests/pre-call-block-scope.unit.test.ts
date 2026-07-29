// tests/pre-call-block-scope.unit.test.ts
import { describe, it, expect } from "vitest";
import { isCampaignLevelBlock } from "../src/lib/dialer/block-scope";

describe("isCampaignLevelBlock", () => {
  it("treats cap and spend blocks as campaign-level", () => {
    // Nothing about the LEAD caused these — every other candidate for the same
    // campaign would hit the identical wall this tick.
    expect(isCampaignLevelBlock("daily_cap_hit")).toBe(true);
    expect(isCampaignLevelBlock("hourly_cap_hit")).toBe(true);
    expect(isCampaignLevelBlock("concurrency_cap_hit")).toBe(true);
    expect(isCampaignLevelBlock("daily_spend_cap_hit")).toBe(true);
    expect(isCampaignLevelBlock("monthly_spend_cap_hit")).toBe(true);
    expect(isCampaignLevelBlock("campaign_not_active")).toBe(true);
    expect(isCampaignLevelBlock("campaign_has_no_numbers")).toBe(true);
  });

  it("treats lead-specific blocks as NOT campaign-level", () => {
    // These are about this one lead, so the tick must keep going and must
    // still bump the lead out of the way.
    expect(isCampaignLevelBlock("call_in_flight")).toBe(false);
    expect(isCampaignLevelBlock("outside_calling_hours")).toBe(false);
    expect(isCampaignLevelBlock("lead_on_dnc")).toBe(false);
    expect(isCampaignLevelBlock("lead_is_mobile")).toBe(false);
    expect(isCampaignLevelBlock("lead_has_no_phone")).toBe(false);
    expect(isCampaignLevelBlock("lead_missing_or_deleted")).toBe(false);
  });

  it("excludes pacing_wait, which has its own handling", () => {
    // pacing_wait IS campaign-scoped, but the tick paces with in-loop sleeps
    // and pre_call_check is only the cross-tick backstop. Short-circuiting the
    // whole tick on it would cut throughput to one call per tick per campaign.
    expect(isCampaignLevelBlock("pacing_wait")).toBe(false);
  });
});
