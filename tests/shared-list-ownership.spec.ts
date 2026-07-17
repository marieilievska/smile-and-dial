import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.describe.configure({ mode: "serial" });

/**
 * Shared-list lead ownership (the cross-campaign double-call guarantee):
 *  - An un-owned lead in a list shared by two active campaigns appears in
 *    dial_queue once PER campaign (first-available).
 *  - claim_lead_for_dial stamps the owner on a first win and refuses a claim
 *    from any other campaign.
 *  - Once owned, the lead appears in dial_queue only for its owner.
 * Live dialing / Twilio are not exercised. Like the other dialer specs, these
 * assume a weekday-daytime run (the dial_queue enforces calling hours); the
 * seeded campaigns use a full-day window to minimize time-of-day flakiness.
 */
test.describe("Shared list ownership", () => {
  const stamp = Date.now();
  const tail = String(stamp).slice(-6);
  let admin: SupabaseClient;
  let ownerId: string;
  let listId: string;
  let goalId: string;
  let numAId: string;
  let numBId: string;
  let agentAId: string;
  let agentBId: string;
  let campAId: string;
  let campBId: string;
  let leadId: string;

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
      .insert({ owner_id: ownerId, name: `E2E Shared List ${stamp}` })
      .select("id")
      .single();
    listId = list!.id as string;

    const { data: goal } = await admin
      .from("goals")
      .insert({ owner_id: ownerId, name: `E2E Shared Goal ${stamp}` })
      .select("id")
      .single();
    goalId = goal!.id as string;

    const mkNumber = async (suffix: string) => {
      const { data } = await admin
        .from("twilio_numbers")
        .insert({
          phone_number: `+1555${tail}${suffix}`,
          friendly_name: `E2E Shared Number ${suffix} ${stamp}`,
          country: "US",
        })
        .select("id")
        .single();
      return data!.id as string;
    };
    numAId = await mkNumber("70");
    numBId = await mkNumber("71");

    const mkAgent = async (label: string) => {
      const { data } = await admin
        .from("agents")
        .insert({
          owner_id: ownerId,
          name: `E2E Shared Agent ${label} ${stamp}`,
          elevenlabs_agent_id: `e2e-shared-${label}-${stamp}`,
          prompt_personality: "x",
          prompt_environment: "x",
          prompt_tone: "x",
          prompt_goal: "x",
          prompt_guardrails: "x",
        })
        .select("id")
        .single();
      return data!.id as string;
    };
    agentAId = await mkAgent("A");
    agentBId = await mkAgent("B");

    const mkCampaign = async (
      label: string,
      agentId: string,
      numberId: string,
    ) => {
      const { data } = await admin
        .from("campaigns")
        .insert({
          owner_id: ownerId,
          goal_id: goalId,
          name: `E2E Shared Campaign ${label} ${stamp}`,
          agent_id: agentId,
          twilio_number_id: numberId,
          status: "active",
          autopilot_enabled: true,
          // Full-day window so the seeded lead is within calling hours whenever
          // the spec runs (matches the other dialer specs' daytime assumption).
          calling_hours_start: "00:00:00",
          calling_hours_end: "23:59:59",
        })
        .select("id")
        .single();
      return data!.id as string;
    };
    campAId = await mkCampaign("A", agentAId, numAId);
    campBId = await mkCampaign("B", agentBId, numBId);

    // Share the one list with BOTH campaigns.
    await admin.from("list_campaign_attachments").insert([
      { list_id: listId, campaign_id: campAId },
      { list_id: listId, campaign_id: campBId },
    ]);

    // A dialable, un-owned lead (landline, in the shared list, due now).
    const { data: lead } = await admin
      .from("leads")
      .insert({
        owner_id: ownerId,
        list_id: listId,
        company: `E2E Shared Co ${stamp}`,
        business_phone: `+1555${tail}72`,
        status: "ready_to_call",
        line_type: "landline",
        timezone: "America/New_York",
      })
      .select("id")
      .single();
    leadId = lead!.id as string;
  });

  test.afterAll(async () => {
    await admin.from("leads").delete().eq("id", leadId);
    await admin
      .from("list_campaign_attachments")
      .delete()
      .eq("list_id", listId);
    await admin.from("campaigns").delete().in("id", [campAId, campBId]);
    await admin.from("goals").delete().eq("id", goalId);
    await admin.from("agents").delete().in("id", [agentAId, agentBId]);
    await admin.from("twilio_numbers").delete().in("id", [numAId, numBId]);
    await admin.from("lists").delete().eq("id", listId);
  });

  test("an un-owned shared lead is offered to both campaigns", async () => {
    const { data } = await admin
      .from("dial_queue")
      .select("lead_id, campaign_id")
      .eq("lead_id", leadId);
    const campaignIds = (data ?? []).map((r) => r.campaign_id).sort();
    expect(campaignIds).toEqual([campAId, campBId].sort());
  });

  test("claim stamps the owner and refuses a non-owner", async () => {
    // Campaign A wins the un-owned lead.
    const { data: wonA } = await admin.rpc("claim_lead_for_dial", {
      in_lead_id: leadId,
      in_campaign_id: campAId,
    });
    expect(wonA).toBe(true);

    const { data: afterA } = await admin
      .from("leads")
      .select("owner_campaign_id")
      .eq("id", leadId)
      .single();
    expect(afterA?.owner_campaign_id).toBe(campAId);

    // Make it due again so the "still due" predicate can't be what blocks B.
    await admin
      .from("leads")
      .update({ next_call_at: new Date(Date.now() - 60_000).toISOString() })
      .eq("id", leadId);

    // Campaign B is refused — the lead is owned by A.
    const { data: wonB } = await admin.rpc("claim_lead_for_dial", {
      in_lead_id: leadId,
      in_campaign_id: campBId,
    });
    expect(wonB).toBe(false);

    const { data: afterB } = await admin
      .from("leads")
      .select("owner_campaign_id")
      .eq("id", leadId)
      .single();
    expect(afterB?.owner_campaign_id).toBe(campAId);
  });

  test("an owned lead surfaces only to its owner", async () => {
    // Ensure it's due so it can appear at all.
    await admin
      .from("leads")
      .update({ next_call_at: new Date(Date.now() - 60_000).toISOString() })
      .eq("id", leadId);
    const { data } = await admin
      .from("dial_queue")
      .select("lead_id, campaign_id")
      .eq("lead_id", leadId);
    expect(data?.length).toBe(1);
    expect(data?.[0]?.campaign_id).toBe(campAId);
  });
});
