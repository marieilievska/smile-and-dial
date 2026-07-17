import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.describe.configure({ mode: "serial" });

/**
 * The DB-level single-active-dial guarantee
 * (calls_one_active_ai_outbound_dial_per_lead):
 *  - A second in-flight AI OUTBOUND call for the same lead is rejected (23505).
 *  - The index is scoped: a terminal (completed) row, an INBOUND in-flight row,
 *    and a HUMAN in-flight row for the same lead all still insert fine.
 * These assert the migration is applied; they do not exercise Twilio/ElevenLabs.
 */
test.describe("Single active dial index", () => {
  const stamp = Date.now();
  const tail = String(stamp).slice(-6);
  let admin: SupabaseClient;
  let ownerId: string;
  let listId: string;
  let goalId: string;
  let numId: string;
  let agentId: string;
  let campaignId: string;
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
      .insert({ owner_id: ownerId, name: `E2E ActiveDial List ${stamp}` })
      .select("id")
      .single();
    listId = list!.id as string;

    const { data: goal } = await admin
      .from("goals")
      .insert({ owner_id: ownerId, name: `E2E ActiveDial Goal ${stamp}` })
      .select("id")
      .single();
    goalId = goal!.id as string;

    const { data: num } = await admin
      .from("twilio_numbers")
      .insert({
        phone_number: `+1555${tail}80`,
        friendly_name: `E2E ActiveDial Number ${stamp}`,
        country: "US",
      })
      .select("id")
      .single();
    numId = num!.id as string;

    const { data: agent } = await admin
      .from("agents")
      .insert({
        owner_id: ownerId,
        name: `E2E ActiveDial Agent ${stamp}`,
        elevenlabs_agent_id: `e2e-activedial-${stamp}`,
        prompt_personality: "x",
        prompt_environment: "x",
        prompt_tone: "x",
        prompt_goal: "x",
        prompt_guardrails: "x",
      })
      .select("id")
      .single();
    agentId = agent!.id as string;

    const { data: campaign } = await admin
      .from("campaigns")
      .insert({
        owner_id: ownerId,
        goal_id: goalId,
        name: `E2E ActiveDial Campaign ${stamp}`,
        agent_id: agentId,
        twilio_number_id: numId,
        status: "active",
        autopilot_enabled: true,
        calling_hours_start: "00:00:00",
        calling_hours_end: "23:59:59",
      })
      .select("id")
      .single();
    campaignId = campaign!.id as string;

    const { data: lead } = await admin
      .from("leads")
      .insert({
        owner_id: ownerId,
        list_id: listId,
        company: `E2E ActiveDial Co ${stamp}`,
        business_phone: `+1555${tail}81`,
        status: "ready_to_call",
        line_type: "landline",
        timezone: "America/New_York",
      })
      .select("id")
      .single();
    leadId = lead!.id as string;
  });

  test.afterAll(async () => {
    await admin.from("calls").delete().eq("lead_id", leadId);
    await admin.from("leads").delete().eq("id", leadId);
    await admin.from("campaigns").delete().eq("id", campaignId);
    await admin.from("goals").delete().eq("id", goalId);
    await admin.from("agents").delete().eq("id", agentId);
    await admin.from("twilio_numbers").delete().eq("id", numId);
    await admin.from("lists").delete().eq("id", listId);
  });

  test("a second active AI outbound call for the same lead is rejected", async () => {
    const first = await admin
      .from("calls")
      .insert({
        lead_id: leadId,
        campaign_id: campaignId,
        direction: "outbound",
        status: "dialing",
        call_mode: "ai",
      })
      .select("id")
      .single();
    expect(first.error).toBeNull();

    const second = await admin
      .from("calls")
      .insert({
        lead_id: leadId,
        campaign_id: campaignId,
        direction: "outbound",
        status: "queued",
        call_mode: "ai",
      })
      .select("id")
      .single();
    expect(second.error?.code).toBe("23505");
  });

  test("terminal, inbound, and human rows for the same lead are allowed", async () => {
    // Terminal AI outbound (not in the partial index predicate).
    const completed = await admin
      .from("calls")
      .insert({
        lead_id: leadId,
        campaign_id: campaignId,
        direction: "outbound",
        status: "completed",
        outcome: "no_answer",
        call_mode: "ai",
      })
      .select("id")
      .single();
    expect(completed.error).toBeNull();

    // In-flight INBOUND (excluded by direction) — must not collide with the
    // active outbound row from the previous test.
    const inbound = await admin
      .from("calls")
      .insert({
        lead_id: leadId,
        campaign_id: campaignId,
        direction: "inbound",
        status: "in_progress",
        call_mode: "ai",
      })
      .select("id")
      .single();
    expect(inbound.error).toBeNull();

    // In-flight HUMAN browser-dial (excluded by call_mode).
    const human = await admin
      .from("calls")
      .insert({
        lead_id: leadId,
        campaign_id: campaignId,
        direction: "outbound",
        status: "dialing",
        call_mode: "human",
      })
      .select("id")
      .single();
    expect(human.error).toBeNull();
  });
});
