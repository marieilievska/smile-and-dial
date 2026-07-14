import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.use({ storageState: "playwright/.auth/user.json" });

test.describe.configure({ mode: "serial" });

/**
 * "Call Now" button on the lead detail modal (Step 34 / BUILD_PLAN §5.1).
 *
 * Coverage:
 *  - Lead modal renders the Call Now button when the lead's list has an
 *    active attached campaign
 *  - Clicking Call → picks the campaign → a calls row appears + lead is
 *    bumped, system_events captures the action
 *  - Pre-call check still gates: with the lead's phone on DNC, the dialog
 *    surfaces the DNC error and no call row is written
 */
test.describe("Call Now from lead modal", () => {
  const stamp = Date.now();
  const tail = String(stamp).slice(-6);

  let admin: SupabaseClient;
  let ownerId: string;
  let listId: string;
  let agentId: string;
  let goalId: string;
  let campaignId: string;
  let twilioNumberId: string;
  const leadIds: string[] = [];

  async function seedLead(suffix: string, phone: string): Promise<string> {
    const { data } = await admin
      .from("leads")
      .insert({
        owner_id: ownerId,
        list_id: listId,
        company: `E2E CallNow Lead ${stamp}-${suffix}`,
        business_phone: phone,
        timezone: "America/New_York",
        status: "ready_to_call",
      })
      .select("id")
      .single();
    leadIds.push(data!.id);
    return data!.id;
  }

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
      .insert({ owner_id: ownerId, name: `E2E CallNow List ${stamp}` })
      .select("id")
      .single();
    listId = list!.id;

    const { data: num } = await admin
      .from("twilio_numbers")
      .insert({
        phone_number: `+1222${tail}90`,
        friendly_name: `E2E CallNow Number ${stamp}`,
        country: "US",
      })
      .select("id")
      .single();
    twilioNumberId = num!.id;

    const { data: agent } = await admin
      .from("agents")
      .insert({
        owner_id: ownerId,
        name: `E2E CallNow Agent ${stamp}`,
        elevenlabs_agent_id: `callnow-agent-${stamp}`,
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
      .insert({ owner_id: ownerId, name: `E2E CallNow Goal ${stamp}` })
      .select("id")
      .single();
    goalId = goal!.id;

    const { data: campaign } = await admin
      .from("campaigns")
      .insert({
        owner_id: ownerId,
        name: `E2E CallNow Campaign ${stamp}`,
        status: "active",
        agent_id: agentId,
        goal_id: goalId,
        twilio_number_id: twilioNumberId,
        // 24h window so we don't depend on local time of day.
        calling_hours_start: "00:00:00",
        calling_hours_end: "23:59:59",
      })
      .select("id")
      .single();
    campaignId = campaign!.id;

    await admin
      .from("twilio_numbers")
      .update({ attached_campaign_id: campaignId })
      .eq("id", twilioNumberId);
    await admin
      .from("list_campaign_attachments")
      .insert({ list_id: listId, campaign_id: campaignId });
  });

  test.afterAll(async () => {
    await admin
      .from("system_events")
      .delete()
      .eq("kind", "call_now")
      .in(
        "ref_id",
        (
          await admin
            .from("calls")
            .select("id")
            .eq("campaign_id", campaignId ?? "")
        ).data?.map((c) => c.id) ?? [],
      );
    await admin
      .from("calls")
      .delete()
      .eq("campaign_id", campaignId ?? "");
    await admin.from("dnc_entries").delete().like("phone", `+1222${tail}%`);
    if (leadIds.length > 0) {
      await admin.from("leads").delete().in("id", leadIds);
    }
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

  test("calls the lead when pre-call check passes", async ({ page }) => {
    const leadId = await seedLead("10", `+1222${tail}10`);

    await page.goto(`/leads/${leadId}`);
    await page.getByRole("button", { name: "Call now" }).click();
    // Campaign Select already has our campaign as the only option.
    await page.getByRole("button", { name: "Call", exact: true }).click();
    await expect(page.getByText("Call placed.")).toBeVisible();

    const { data: calls } = await admin
      .from("calls")
      .select("id, outcome, direction, campaign_id")
      .eq("lead_id", leadId);
    expect((calls ?? []).length).toBe(1);
    expect(calls![0].direction).toBe("outbound");
    expect(calls![0].outcome).toBe("no_answer");
    expect(calls![0].campaign_id).toBe(campaignId);

    const { data: events } = await admin
      .from("system_events")
      .select("kind, payload")
      .eq("kind", "call_now")
      .eq("ref_id", calls![0].id);
    expect((events ?? []).length).toBeGreaterThanOrEqual(1);
    expect(events![0].payload).toMatchObject({
      lead_id: leadId,
      campaign_id: campaignId,
    });
  });

  test("pre-call check blocks Call Now when the lead's phone is on DNC", async ({
    page,
  }) => {
    const phone = `+1222${tail}20`;
    const leadId = await seedLead("20", phone);
    // Put the lead's phone on DNC.
    await admin
      .from("dnc_entries")
      .insert({ phone, reason: "manual", company_snapshot: "test" });

    await page.goto(`/leads/${leadId}`);
    await page.getByRole("button", { name: "Call now" }).click();
    await page.getByRole("button", { name: "Call", exact: true }).click();
    await expect(
      page.getByText("This number is on the DNC list."),
    ).toBeVisible();

    // No call row was written.
    const { data: calls } = await admin
      .from("calls")
      .select("id")
      .eq("lead_id", leadId);
    expect((calls ?? []).length).toBe(0);
  });

  test("Call Now is blocked when the lead already has an active call", async ({
    page,
  }) => {
    const leadId = await seedLead("30", `+1222${tail}30`);
    // Simulate a call already in flight for this lead (the autopilot tick
    // placed one, or a first click is mid-dial). Call Now must not add a
    // second simultaneous live call to the same business.
    await admin.from("calls").insert({
      lead_id: leadId,
      campaign_id: campaignId,
      agent_id: agentId,
      twilio_number_id: twilioNumberId,
      direction: "outbound",
      status: "dialing",
    });

    await page.goto(`/leads/${leadId}`);
    await page.getByRole("button", { name: "Call now" }).click();
    await page.getByRole("button", { name: "Call", exact: true }).click();
    await expect(
      page.getByText("This lead already has a call in progress."),
    ).toBeVisible();

    // Still just the one in-flight call — no second row was written.
    const { data: calls } = await admin
      .from("calls")
      .select("id")
      .eq("lead_id", leadId);
    expect((calls ?? []).length).toBe(1);
  });
});
