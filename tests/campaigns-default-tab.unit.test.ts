// tests/campaigns-default-tab.unit.test.ts
import { describe, expect, it } from "vitest";

import {
  DEFAULT_TAB_ORDER,
  resolveCampaignTab,
} from "@/app/(app)/campaigns/default-tab";

const counts = (over: Record<string, number> = {}) => ({
  active: 0,
  draft: 0,
  paused: 0,
  ended: 0,
  all: 0,
  ...over,
});

describe("resolveCampaignTab", () => {
  it("prefers active when a campaign is running", () => {
    expect(
      resolveCampaignTab(null, counts({ active: 2, paused: 1, all: 3 })),
    ).toBe("active");
  });

  it("falls through to paused when nothing is active — the live case", () => {
    // 0 active, 1 paused: the page used to show "No campaigns match this
    // status" while holding a campaign.
    expect(resolveCampaignTab(null, counts({ paused: 1, all: 1 }))).toBe(
      "paused",
    );
  });

  it("falls through to draft, then ended", () => {
    expect(resolveCampaignTab(null, counts({ draft: 3, all: 3 }))).toBe(
      "draft",
    );
    expect(resolveCampaignTab(null, counts({ ended: 4, all: 4 }))).toBe(
      "ended",
    );
  });

  it("never picks 'all' on its own — it mixes ended in with live", () => {
    expect(DEFAULT_TAB_ORDER).not.toContain("all");
    // Only `all` is non-zero (not reachable in practice, but the guarantee
    // is that the fallback is a real status tab, not the mixed view).
    expect(resolveCampaignTab(null, counts({ all: 5 }))).toBe("active");
  });

  it("falls back to active for an empty workspace", () => {
    expect(resolveCampaignTab(null, counts())).toBe("active");
  });

  it("NEVER overrides an explicit choice, even an empty tab", () => {
    // The status tabs must keep working as plain filters — clicking "Ended"
    // on a workspace with no ended campaigns shows the empty state, not a
    // surprise redirect to another tab.
    expect(resolveCampaignTab("ended", counts({ active: 9, all: 9 }))).toBe(
      "ended",
    );
    expect(resolveCampaignTab("all", counts({ paused: 1, all: 1 }))).toBe(
      "all",
    );
    expect(resolveCampaignTab("active", counts({ paused: 1, all: 1 }))).toBe(
      "active",
    );
  });

  it("orders by how much the tab wants attention", () => {
    expect([...DEFAULT_TAB_ORDER]).toEqual([
      "active",
      "paused",
      "draft",
      "ended",
    ]);
  });
});
