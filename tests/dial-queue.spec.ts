import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.use({ storageState: "playwright/.auth/user.json" });

test.describe.configure({ mode: "serial" });

/**
 * The dial_queue view + pre_call_check function are the foundation the
 * cron will sit on (Step 21b). These tests poke them directly through the
 * service-role client — no UI yet.
 */
test.describe("Dial queue", () => {
  const stamp = Date.now();
  const tail = String(stamp).slice(-6);
  const phone = `+1555${tail}90`;

  let admin: SupabaseClient;
  let ownerId: string;
  let listId: string;
  let twilioNumberId: string;
  let campaignId: string;
  let leadId: string;
  let agentId: string;
  let goalId: string;

  test.beforeAll(async () => {
    admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    // Use the existing E2E admin account as the owner.
    const { data: owner } = await admin
      .from("profiles")
      .select("id")
      .eq("email", process.env.E2E_TEST_EMAIL ?? "")
      .single();
    ownerId = owner!.id;

    // Seed a list, a Twilio number, an agent, a campaign, and a lead — all
    // wired together so the lead lands in dial_queue.
    const { data: list } = await admin
      .from("lists")
      .insert({ owner_id: ownerId, name: `E2E Queue List ${stamp}` })
      .select("id")
      .single();
    listId = list!.id;

    const { data: num } = await admin
      .from("twilio_numbers")
      .insert({
        phone_number: `+1555${tail}80`,
        friendly_name: `E2E Queue Number ${stamp}`,
        country: "US",
      })
      .select("id")
      .single();
    twilioNumberId = num!.id;

    const { data: agent } = await admin
      .from("agents")
      .insert({
        owner_id: ownerId,
        name: `E2E Queue Agent ${stamp}`,
        elevenlabs_agent_id: `e2e-queue-${stamp}`,
        prompt_personality: "x",
        prompt_environment: "x",
        prompt_tone: "x",
        prompt_goal: "x",
        prompt_guardrails: "x",
      })
      .select("id")
      .single();
    agentId = agent!.id;

    const { data: goal } = await admin
      .from("goals")
      .insert({ owner_id: ownerId, name: `E2E Queue Goal ${stamp}` })
      .select("id")
      .single();
    goalId = goal!.id;

    const { data: campaign } = await admin
      .from("campaigns")
      .insert({
        owner_id: ownerId,
        name: `E2E Queue Campaign ${stamp}`,
        status: "active",
        agent_id: agentId,
        goal_id: goalId,
        twilio_number_id: twilioNumberId,
        calls_per_hour_cap: 30,
        calls_per_day_cap: 300,
        concurrency_cap_per_user: 2,
      })
      .select("id")
      .single();
    campaignId = campaign!.id;

    // Attach the Twilio number to the campaign (denormalized pointer).
    await admin
      .from("twilio_numbers")
      .update({ attached_campaign_id: campaignId })
      .eq("id", twilioNumberId);

    // Attach the list to the campaign.
    await admin.from("list_campaign_attachments").insert({
      list_id: listId,
      campaign_id: campaignId,
    });

    // Seed the lead.
    const { data: lead } = await admin
      .from("leads")
      .insert({
        owner_id: ownerId,
        list_id: listId,
        company: `E2E Queue Co ${stamp}`,
        business_phone: phone,
        timezone: "America/New_York",
        status: "ready_to_call",
        // next_call_at left null → due immediately.
      })
      .select("id")
      .single();
    leadId = lead!.id;
  });

  test.afterAll(async () => {
    await admin
      .from("calls")
      .delete()
      .eq("lead_id", leadId ?? "");
    await admin.from("dnc_entries").delete().eq("phone", phone);
    await admin
      .from("leads")
      .delete()
      .eq("id", leadId ?? "");
    await admin
      .from("list_campaign_attachments")
      .delete()
      .eq("campaign_id", campaignId ?? "");
    await admin
      .from("twilio_numbers")
      .update({ attached_campaign_id: null })
      .eq("id", twilioNumberId ?? "");
    await admin
      .from("campaigns")
      .delete()
      .eq("id", campaignId ?? "");
    await admin
      .from("agents")
      .delete()
      .eq("id", agentId ?? "");
    await admin
      .from("twilio_numbers")
      .delete()
      .eq("id", twilioNumberId ?? "");
    await admin
      .from("goals")
      .delete()
      .eq("id", goalId ?? "");
    await admin
      .from("lists")
      .delete()
      .eq("id", listId ?? "");
  });

  async function leadInQueue(): Promise<boolean> {
    const { data } = await admin
      .from("dial_queue")
      .select("lead_id")
      .eq("lead_id", leadId);
    return (data?.length ?? 0) > 0;
  }

  async function preCheck(): Promise<string | null> {
    const { data } = await admin.rpc("pre_call_check", {
      in_lead_id: leadId,
      in_campaign_id: campaignId,
    });
    return (data ?? null) as string | null;
  }

  test("a seeded lead lands in dial_queue and passes pre_call_check", async () => {
    expect(await leadInQueue()).toBe(true);
    expect(await preCheck()).toBeNull();
  });

  test("adding the lead's phone to DNC drops it from the queue", async () => {
    await admin
      .from("dnc_entries")
      .insert({ phone, reason: "manual", company_snapshot: "test" });
    expect(await leadInQueue()).toBe(false);
    expect(await preCheck()).toBe("lead_on_dnc");

    // Clean up so the next test starts from a known good state.
    await admin.from("dnc_entries").delete().eq("phone", phone);
    expect(await leadInQueue()).toBe(true);
  });

  test("pausing the campaign drops the lead from the queue", async () => {
    await admin
      .from("campaigns")
      .update({ status: "paused" })
      .eq("id", campaignId);
    expect(await leadInQueue()).toBe(false);
    expect(await preCheck()).toBe("campaign_not_active");

    await admin
      .from("campaigns")
      .update({ status: "active" })
      .eq("id", campaignId);
    expect(await leadInQueue()).toBe(true);
  });

  test("detaching the list drops the lead from the queue", async () => {
    await admin
      .from("list_campaign_attachments")
      .update({ detached_at: new Date().toISOString() })
      .eq("campaign_id", campaignId)
      .eq("list_id", listId);
    expect(await leadInQueue()).toBe(false);

    // Re-attach for the next test.
    await admin
      .from("list_campaign_attachments")
      .update({ detached_at: null })
      .eq("campaign_id", campaignId)
      .eq("list_id", listId);
    expect(await leadInQueue()).toBe(true);
  });

  test("hitting the hourly cap blocks pre_call_check but not the view", async () => {
    // Lower the cap to 1 so a single seeded call trips it.
    await admin
      .from("campaigns")
      .update({ calls_per_hour_cap: 1 })
      .eq("id", campaignId);
    await admin.from("calls").insert({
      lead_id: leadId,
      campaign_id: campaignId,
      direction: "outbound",
      status: "completed",
    });

    // The view stays light, so the lead is still queued — but pre_call_check
    // is the gate that actually blocks the dial.
    expect(await leadInQueue()).toBe(true);
    expect(await preCheck()).toBe("hourly_cap_hit");

    // Reset.
    await admin
      .from("campaigns")
      .update({ calls_per_hour_cap: 30 })
      .eq("id", campaignId);
    await admin.from("calls").delete().eq("lead_id", leadId);
    expect(await preCheck()).toBeNull();
  });

  test("an outside-calling-hours window drops the lead", async () => {
    // Build a 1-minute window that's deterministically two hours ahead of
    // the lead's current local clock — so it can never accidentally include
    // "now" no matter when the test runs.
    const nowNy = new Date(
      new Date().toLocaleString("en-US", { timeZone: "America/New_York" }),
    );
    const target = new Date(nowNy.getTime() + 2 * 60 * 60 * 1000);
    const hh = String(target.getHours()).padStart(2, "0");
    const mm = String(target.getMinutes()).padStart(2, "0");
    const windowStart = `${hh}:${mm}:00`;
    const windowEnd = `${hh}:${mm}:30`;
    await admin
      .from("campaigns")
      .update({
        calling_hours_start: windowStart,
        calling_hours_end: windowEnd,
      })
      .eq("id", campaignId);
    expect(await leadInQueue()).toBe(false);
    expect(await preCheck()).toBe("outside_calling_hours");

    await admin
      .from("campaigns")
      .update({
        calling_hours_start: "00:00:00",
        calling_hours_end: "23:59:59",
      })
      .eq("id", campaignId);
    expect(await leadInQueue()).toBe(true);
  });
});
