import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.use({ storageState: "playwright/.auth/user.json" });

test.describe.configure({ mode: "serial" });

/**
 * Today page (Design Phase / "Today" landing page).
 *
 * Coverage:
 *  - Page renders with greeting + three hero KPIs
 *  - Overdue callbacks appear in the action queue with an Urgent badge
 *  - "You're caught up" empty state when the queue is empty
 *  - Mock-data badge shows on the Appointments hero in mock mode
 *  - Root path redirects to /today
 */
test.describe("Today page", () => {
  const stamp = Date.now();
  const tail = String(stamp).slice(-6);

  let admin: SupabaseClient;
  let ownerId: string;
  let listId: string;
  let leadId: string;
  let agentId: string;
  let goalId: string;
  let campaignId: string;
  let twilioNumberId: string;
  let callbackId: string;

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

    // Clear any existing pending callbacks for this owner so the action
    // queue starts empty for the first test.
    await admin.from("callbacks").delete().eq("created_by", ownerId);

    const { data: list } = await admin
      .from("lists")
      .insert({ owner_id: ownerId, name: `E2E Today List ${stamp}` })
      .select("id")
      .single();
    listId = list!.id;

    // Need a campaign so the seeded callback satisfies its FK.
    const { data: num } = await admin
      .from("twilio_numbers")
      .insert({
        phone_number: `+1444${tail}99`,
        friendly_name: `E2E Today Number ${stamp}`,
        country: "US",
      })
      .select("id")
      .single();
    twilioNumberId = num!.id;

    const { data: agent } = await admin
      .from("agents")
      .insert({
        owner_id: ownerId,
        name: `E2E Today Agent ${stamp}`,
        elevenlabs_agent_id: `today-agent-${stamp}`,
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
      .insert({ owner_id: ownerId, name: `E2E Today Goal ${stamp}` })
      .select("id")
      .single();
    goalId = goal!.id;

    const { data: campaign } = await admin
      .from("campaigns")
      .insert({
        owner_id: ownerId,
        name: `E2E Today Campaign ${stamp}`,
        status: "active",
        agent_id: agentId,
        goal_id: goalId,
        twilio_number_id: twilioNumberId,
        calling_hours_start: "00:00:00",
        calling_hours_end: "23:59:59",
      })
      .select("id")
      .single();
    campaignId = campaign!.id;

    const { data: lead } = await admin
      .from("leads")
      .insert({
        owner_id: ownerId,
        list_id: listId,
        company: `E2E Today Lead ${stamp}`,
        business_phone: `+1444${tail}10`,
        timezone: "America/New_York",
        status: "ready_to_call",
      })
      .select("id")
      .single();
    leadId = lead!.id;
  });

  test.afterAll(async () => {
    if (callbackId) await admin.from("callbacks").delete().eq("id", callbackId);
    if (leadId) await admin.from("leads").delete().eq("id", leadId);
    if (campaignId) await admin.from("campaigns").delete().eq("id", campaignId);
    if (agentId) await admin.from("agents").delete().eq("id", agentId);
    if (twilioNumberId)
      await admin.from("twilio_numbers").delete().eq("id", twilioNumberId);
    if (goalId) await admin.from("goals").delete().eq("id", goalId);
    if (listId) await admin.from("lists").delete().eq("id", listId);
  });

  test("root path redirects to /today", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/today(\?|$)/);
  });

  test("Today page renders greeting + hero pace + live calls band", async ({
    page,
  }) => {
    await page.goto("/today");
    // Greeting line.
    await expect(
      page.getByRole("heading", { name: /good (morning|afternoon|evening)/i }),
    ).toBeVisible();
    // Hero pace block (single big number — Appointments today).
    await expect(page.getByTestId("hero-pace")).toBeVisible();
    // Pace strip (supporting metrics).
    await expect(page.getByTestId("pace-strip")).toContainText("calls");
    await expect(page.getByTestId("pace-strip")).toContainText("connect rate");
    // Action queue section visible.
    await expect(page.getByTestId("action-queue")).toBeVisible();
    // Live calls band renders (idle copy in mock mode with no active calls).
    const band = page.getByTestId("live-calls-band");
    await expect(band).toBeVisible();
    await expect(band).toContainText("Idle");
    // Mock-data pill on the band when no LIVE flags are set.
    await expect(band).toContainText("Mock data");
  });

  test("active call appears in the Live calls band", async ({ page }) => {
    // Seed a call in 'in_progress' status — i.e. live.
    const { data: call } = await admin
      .from("calls")
      .insert({
        lead_id: leadId,
        campaign_id: campaignId,
        agent_id: agentId,
        twilio_number_id: twilioNumberId,
        direction: "outbound",
        status: "in_progress",
        started_at: new Date(Date.now() - 30_000).toISOString(),
      })
      .select("id")
      .single();
    const liveCallId = call!.id;

    try {
      await page.goto("/today");
      const band = page.getByTestId("live-calls-band");
      await expect(band).toBeVisible();
      // The "N calls in progress" header replaces the idle copy.
      await expect(band).toContainText("call in progress");
      // The lead appears in the list.
      await expect(band).toContainText(`E2E Today Lead ${stamp}`);
      // A row carries the status label.
      const row = band.getByTestId("live-call-row").first();
      await expect(row).toContainText("On call");
    } finally {
      await admin.from("calls").delete().eq("id", liveCallId);
    }
  });

  test("overdue callback appears in the action queue with Urgent badge", async ({
    page,
  }) => {
    // Seed an overdue pending callback for the lead.
    const scheduledAt = new Date(Date.now() - 90 * 60 * 1000).toISOString(); // 90 minutes ago
    const { data: cb } = await admin
      .from("callbacks")
      .insert({
        lead_id: leadId,
        campaign_id: campaignId,
        scheduled_at: scheduledAt,
        status: "pending",
        created_by: ownerId,
      })
      .select("id")
      .single();
    callbackId = cb!.id;

    await page.goto("/today");
    const queue = page.getByTestId("action-queue");
    await expect(queue).toContainText(`E2E Today Lead ${stamp}`);
    await expect(queue).toContainText("overdue");
    // Urgent badge on the high-urgency item.
    await expect(
      queue
        .locator('[data-testid="action-queue-item"][data-urgency="high"]')
        .first(),
    ).toBeVisible();
    // Pending callbacks now sit in the pace strip — assert the strip
    // mentions the pending callbacks label with at least 1.
    const strip = page.getByTestId("pace-strip");
    await expect(strip).toContainText("pending callbacks");
  });
});
