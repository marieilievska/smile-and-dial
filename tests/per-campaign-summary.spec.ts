import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { mergeLeadSummary } from "../src/lib/openai/summary-merger";

test.describe.configure({ mode: "serial" });

/**
 * Per-campaign summary scoping (feat/per-campaign-summary).
 *
 * Proves that mergeLeadSummary writes the correct (lead, campaignA) row in
 * lead_campaign_summaries, leaves campaignB's row untouched, and dual-writes
 * leads.ai_summary.
 */
test.describe("per-campaign summary", () => {
  const stamp = Date.now();
  const tail = String(stamp).slice(-6);

  let admin: SupabaseClient;
  let ownerId: string;
  let listId: string;
  let leadId: string;
  let campA: string;
  let campB: string;

  test.beforeAll(async () => {
    admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    // Look up the E2E owner profile — same env var as openai-summary.spec.ts.
    const { data: owner } = await admin
      .from("profiles")
      .select("id")
      .eq("email", process.env.E2E_TEST_EMAIL ?? "")
      .single();
    ownerId = owner!.id;

    // Create a list to satisfy the leads.list_id FK.
    const { data: list } = await admin
      .from("lists")
      .insert({ owner_id: ownerId, name: `E2E PerCamp List ${stamp}` })
      .select("id")
      .single();
    listId = list!.id;

    // Create the lead under that list.
    const { data: lead } = await admin
      .from("leads")
      .insert({
        owner_id: ownerId,
        list_id: listId,
        company: `E2E PerCamp Lead ${stamp}`,
        business_phone: `+1444${tail}20`,
        timezone: "America/New_York",
        status: "ready_to_call",
        ai_summary: "we know we just imported them / we last left off n/a",
      })
      .select("id")
      .single();
    leadId = lead!.id;

    // Reuse an existing agent + goal (same pattern as openai-summary.spec.ts).
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

    // Create two separate campaigns — the subject under test.
    const { data: campaignA } = await admin
      .from("campaigns")
      .insert({
        owner_id: ownerId,
        name: `E2E PerCamp A ${stamp}`,
        agent_id: agent!.id,
        goal_id: goal!.id,
      })
      .select("id")
      .single();
    campA = campaignA!.id;

    const { data: campaignB } = await admin
      .from("campaigns")
      .insert({
        owner_id: ownerId,
        name: `E2E PerCamp B ${stamp}`,
        agent_id: agent!.id,
        goal_id: goal!.id,
      })
      .select("id")
      .single();
    campB = campaignB!.id;
  });

  test.afterAll(async () => {
    // lead_campaign_summaries rows are deleted by ON DELETE CASCADE when the
    // lead is deleted, but delete them explicitly first to be safe.
    if (leadId)
      await admin
        .from("lead_campaign_summaries")
        .delete()
        .eq("lead_id", leadId);
    if (leadId) await admin.from("leads").delete().eq("id", leadId);
    if (listId) await admin.from("lists").delete().eq("id", listId);
    if (campA) await admin.from("campaigns").delete().eq("id", campA);
    if (campB) await admin.from("campaigns").delete().eq("id", campB);
  });

  test("merge writes the campaign's row (mock) and not the other", async () => {
    await mergeLeadSummary({
      leadId,
      campaignId: campA,
      latestSummary:
        "Reached front desk; owner never in; manager Jane handles leads.",
    });

    // Campaign A row must exist and be non-empty.
    const { data: a } = await admin
      .from("lead_campaign_summaries")
      .select("ai_summary")
      .eq("lead_id", leadId)
      .eq("campaign_id", campA)
      .maybeSingle();

    // Campaign B row must not exist — merge was scoped to A only.
    const { data: b } = await admin
      .from("lead_campaign_summaries")
      .select("ai_summary")
      .eq("lead_id", leadId)
      .eq("campaign_id", campB)
      .maybeSingle();

    expect(a?.ai_summary ?? "").not.toEqual("");
    expect(b).toBeNull();

    // leads.ai_summary must also have been updated (dual-write).
    const { data: leadRow } = await admin
      .from("leads")
      .select("ai_summary")
      .eq("id", leadId)
      .maybeSingle();
    expect(leadRow?.ai_summary ?? "").not.toEqual("");
  });
});
