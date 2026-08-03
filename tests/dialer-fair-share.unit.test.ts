import { describe, expect, it } from "vitest";

import { mergeFairShare, type QueueRow } from "@/lib/dialer/tick";

/**
 * The fair-share tick window.
 *
 * THE BUG THIS GUARDS (prod, 2026-08-03): the dialer took the global top 50
 * rows of `dial_queue`. Two campaigns attached to the same list produce two
 * rows per lead — one each — and both tie on every sort key, so the tie broke
 * whichever way the query plan happened to emit rows. It broke the same way
 * every time: 50 of 50 slots went to ONE campaign. The other had 61,735
 * eligible leads, 20 usable numbers and `pre_call_check` returning "clear to
 * dial", and had never been auto-dialled once. Lead ownership
 * (`claim_lead_for_dial`) was never the problem — a campaign that never
 * appears in the window never gets far enough to claim anything.
 *
 * Then it got worse: the campaign holding all 50 slots hit its hourly cap, the
 * campaign-level short-circuit correctly skipped the other 49 candidates of
 * that same capped campaign, and the tick dialled NOTHING while a ready
 * campaign sat idle.
 *
 * These tests assert the properties that make that impossible.
 */

let seq = 0;
function row(campaign: string, over: Partial<QueueRow> = {}): QueueRow {
  seq += 1;
  return {
    lead_id: `lead-${seq}`,
    owner_id: "owner-1",
    business_phone: "+15550000000",
    campaign_id: campaign,
    agent_id: "agent-1",
    is_redial_due: false,
    redial_number_id: null,
    dial_priority: 1,
    ...over,
  };
}

const slice = (campaign: string, n: number): QueueRow[] =>
  Array.from({ length: n }, () => row(campaign));

const countByCampaign = (rows: QueueRow[]): Record<string, number> =>
  rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.campaign_id as string] = (acc[r.campaign_id as string] ?? 0) + 1;
    return acc;
  }, {});

describe("mergeFairShare", () => {
  it("splits the window evenly when both campaigns have a full backlog", () => {
    // The regression case. Before the fix this window was 50/0.
    const merged = mergeFairShare([slice("a", 50), slice("b", 50)], 50);

    expect(merged).toHaveLength(50);
    expect(countByCampaign(merged)).toEqual({ a: 25, b: 25 });
  });

  it("never lets one campaign take the whole window, however deep its backlog", () => {
    // Campaign "a" offers 500 candidates, "b" offers 4. "a" must not shut "b"
    // out — every one of b's leads has to make the window.
    const merged = mergeFairShare([slice("a", 500), slice("b", 4)], 50);
    const counts = countByCampaign(merged);

    expect(counts.b).toBe(4);
    expect(counts.a).toBe(46); // b's unused share flows back to a, not wasted
    expect(merged).toHaveLength(50);
  });

  it("gives every campaign a turn when there are more than two", () => {
    const merged = mergeFairShare(
      [slice("a", 50), slice("b", 50), slice("c", 50), slice("d", 50)],
      50,
    );
    const counts = countByCampaign(merged);

    expect(Object.keys(counts).sort()).toEqual(["a", "b", "c", "d"]);
    // 50 doesn't divide by 4, so two campaigns get 13 and two get 12.
    for (const n of Object.values(counts)) {
      expect(n).toBeGreaterThanOrEqual(12);
      expect(n).toBeLessThanOrEqual(13);
    }
  });

  it("drops a duplicate lead rather than spending a slot on a doomed claim", () => {
    // Campaigns sharing a list see the SAME un-owned leads. Only one can win
    // `claim_lead_for_dial`, so the second copy must not consume a slot.
    const shared = row("a");
    const bSeesTheSameLead: QueueRow = { ...shared, campaign_id: "b" };

    const merged = mergeFairShare(
      [
        [shared, ...slice("a", 3)],
        [bSeesTheSameLead, ...slice("b", 3)],
      ],
      8,
    );

    const ids = merged.map((r) => r.lead_id);
    expect(new Set(ids).size).toBe(ids.length); // no lead twice
    // b skipped the duplicate and spent that turn on its next lead instead, so
    // it still gets its full share of the window.
    expect(countByCampaign(merged)).toEqual({ a: 4, b: 3 });
  });

  it("keeps scheduled callbacks ahead of every campaign's cold leads", () => {
    // A callback is a promise to a person at an agreed time. Fair share must
    // not bury it behind another campaign's cold backlog.
    const merged = mergeFairShare(
      [
        slice("a", 10),
        [
          row("b", { dial_priority: 0, lead_id: "the-callback" }),
          ...slice("b", 9),
        ],
      ],
      10,
    );

    expect(merged[0].lead_id).toBe("the-callback");
  });

  it("keeps a due double-call redial ahead of cold leads in its band", () => {
    // A redial only has a 10-minute window; if it sorts behind cold leads it
    // never fires.
    const merged = mergeFairShare(
      [
        slice("a", 10),
        [
          row("b", { is_redial_due: true, lead_id: "the-redial" }),
          ...slice("b", 9),
        ],
      ],
      10,
    );

    expect(merged[0].lead_id).toBe("the-redial");
  });

  it("returns an empty window when no campaign has candidates", () => {
    expect(mergeFairShare([[], []], 50)).toEqual([]);
    expect(mergeFairShare([], 50)).toEqual([]);
  });
});
