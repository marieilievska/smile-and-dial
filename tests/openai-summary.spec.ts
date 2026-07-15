import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { mergeLeadSummary, mockMerge } from "../src/lib/openai/summary-merger";

test.describe.configure({ mode: "serial" });

/**
 * OpenAI rolling summary merger (Step 39 / BUILD_PLAN §13).
 *
 * Coverage:
 *  - mockMerge produces the "we know X / we last left off Y" structure
 *  - mergeLeadSummary writes the new ai_summary onto the lead
 *  - Live mode is hard-gated behind OPENAI_LIVE — when unset, no API
 *    calls fire and the cost stays $0
 */
test.describe("OpenAI summary merger (mock)", () => {
  test.use({ storageState: "playwright/.auth/user.json" });

  const stamp = Date.now();
  const tail = String(stamp).slice(-6);

  let admin: SupabaseClient;
  let ownerId: string;
  let listId: string;
  let leadId: string;
  let campaignId: string;

  test.beforeAll(async () => {
    admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const { data: owner } = await admin
      .from("profiles")
      .select("id")
      .eq("email", process.env.E2E_TEST_EMAIL ?? "")
      .single();
    ownerId = owner!.id;

    const { data: list } = await admin
      .from("lists")
      .insert({ owner_id: ownerId, name: `E2E Summary List ${stamp}` })
      .select("id")
      .single();
    listId = list!.id;

    const { data: lead } = await admin
      .from("leads")
      .insert({
        owner_id: ownerId,
        list_id: listId,
        company: `E2E Summary Lead ${stamp}`,
        business_phone: `+1333${tail}10`,
        timezone: "America/New_York",
        status: "ready_to_call",
      })
      .select("id")
      .single();
    leadId = lead!.id;

    const { data: agent } = await admin
      .from("agents")
      .select("id")
      .eq("owner_id", ownerId)
      .limit(1)
      .maybeSingle();
    const { data: goal } = await admin
      .from("goals")
      .select("id")
      .limit(1)
      .maybeSingle();
    const { data: campaign } = await admin
      .from("campaigns")
      .insert({
        owner_id: ownerId,
        name: `E2E Summary Campaign ${stamp}`,
        agent_id: agent!.id,
        goal_id: goal!.id,
      })
      .select("id")
      .single();
    campaignId = campaign!.id;
  });

  test.afterAll(async () => {
    if (leadId)
      await admin
        .from("lead_campaign_summaries")
        .delete()
        .eq("lead_id", leadId);
    if (campaignId) await admin.from("campaigns").delete().eq("id", campaignId);
    if (leadId) await admin.from("leads").delete().eq("id", leadId);
    if (listId) await admin.from("lists").delete().eq("id", listId);
  });

  test("mockMerge produces the 'we know X / we last left off Y' shape", () => {
    const merged = mockMerge(
      "we know they're a yoga studio / we last left off n/a",
      "Owner asked for a follow-up next week",
    );
    expect(merged.toLowerCase()).toContain("we know");
    expect(merged.toLowerCase()).toContain("we last left off");
  });

  test("mergeLeadSummary writes the new summary to the per-campaign row", async () => {
    const result = await mergeLeadSummary({
      leadId,
      campaignId,
      latestSummary: "Owner committed to a Thursday discovery call.",
    });
    expect(result.mode).toBe("mock");
    expect(result.cost).toBe(0);
    expect(result.newSummary).toBeTruthy();

    // The rolling note lives per-campaign in lead_campaign_summaries
    // (leads.ai_summary was dropped 2026-07-02).
    const { data: row } = await admin
      .from("lead_campaign_summaries")
      .select("ai_summary")
      .eq("lead_id", leadId)
      .eq("campaign_id", campaignId)
      .maybeSingle();
    expect(row?.ai_summary).toContain("Thursday discovery call");
  });

  test("with no transcript and no latest summary, nothing is written", async () => {
    const result = await mergeLeadSummary({
      leadId,
      campaignId,
      latestSummary: null,
    });
    expect(result.newSummary).toBeNull();
    expect(result.cost).toBe(0);
  });
});
