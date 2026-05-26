import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.use({ storageState: "playwright/.auth/user.json" });

test.describe.configure({ mode: "serial" });

/**
 * Analytics page (Step 35 / BUILD_PLAN §5.6).
 *
 * Coverage:
 *  - KPI tiles render with computed values across a seeded set of calls
 *  - Funnel rolls calls through Dialed → Connected → Conversation → DMs
 *    Reached → Goal Met
 *  - Campaign slicer narrows the dashboard to one campaign's data
 *  - "vs prior period" toggle adds delta badges to the tiles
 */
test.describe("Analytics page", () => {
  const stamp = Date.now();
  const tail = String(stamp).slice(-6);

  let admin: SupabaseClient;
  let ownerId: string;
  let listId: string;
  let agentId: string;
  let goalId: string;
  let campaignAId: string;
  let campaignBId: string;
  let twilioNumberAId: string;
  let twilioNumberBId: string;
  const leadIds: string[] = [];
  const callIds: string[] = [];

  function todayStr(): string {
    return new Date().toISOString().slice(0, 10);
  }
  function daysAgoStr(days: number): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - days);
    return d.toISOString().slice(0, 10);
  }

  async function seedLead(suffix: string): Promise<string> {
    const { data } = await admin
      .from("leads")
      .insert({
        owner_id: ownerId,
        list_id: listId,
        company: `E2E Analytics Lead ${stamp}-${suffix}`,
        business_phone: `+1666${tail}${suffix}`,
        timezone: "America/New_York",
        status: "ready_to_call",
      })
      .select("id")
      .single();
    leadIds.push(data!.id);
    return data!.id;
  }

  async function seedCall(opts: {
    leadId: string;
    campaignId: string;
    outcome: string | null;
    goalMet: boolean;
    duration: number;
    spend: number;
    daysAgo: number;
    twilioNumberId: string;
  }) {
    const started = new Date();
    started.setUTCDate(started.getUTCDate() - opts.daysAgo);
    const { data } = await admin
      .from("calls")
      .insert({
        lead_id: opts.leadId,
        campaign_id: opts.campaignId,
        agent_id: agentId,
        twilio_number_id: opts.twilioNumberId,
        direction: "outbound",
        status: "completed",
        outcome: opts.outcome,
        outcome_source: opts.outcome ? "twilio" : null,
        goal_met: opts.goalMet,
        started_at: started.toISOString(),
        ended_at: new Date(
          started.getTime() + opts.duration * 1000,
        ).toISOString(),
        duration_seconds: opts.duration,
        talk_time_seconds: Math.min(opts.duration, 60),
        cost_breakdown: {
          twilio: opts.spend / 2,
          elevenlabs: opts.spend / 2,
          openai: 0,
          lookup: 0,
          total: opts.spend,
        },
        created_at: started.toISOString(),
      })
      .select("id")
      .single();
    callIds.push(data!.id);
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
      .insert({ owner_id: ownerId, name: `E2E Analytics List ${stamp}` })
      .select("id")
      .single();
    listId = list!.id;

    const { data: numA } = await admin
      .from("twilio_numbers")
      .insert({
        phone_number: `+1666${tail}A0`.replace("A", "9"),
        friendly_name: `E2E Analytics Num A ${stamp}`,
        country: "US",
      })
      .select("id")
      .single();
    twilioNumberAId = numA!.id;

    const { data: numB } = await admin
      .from("twilio_numbers")
      .insert({
        phone_number: `+1666${tail}B0`.replace("B", "8"),
        friendly_name: `E2E Analytics Num B ${stamp}`,
        country: "US",
      })
      .select("id")
      .single();
    twilioNumberBId = numB!.id;

    const { data: agent } = await admin
      .from("agents")
      .insert({
        owner_id: ownerId,
        name: `E2E Analytics Agent ${stamp}`,
        elevenlabs_agent_id: `analytics-agent-${stamp}`,
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
      .insert({ owner_id: ownerId, name: `E2E Analytics Goal ${stamp}` })
      .select("id")
      .single();
    goalId = goal!.id;

    const { data: campA } = await admin
      .from("campaigns")
      .insert({
        owner_id: ownerId,
        name: `E2E Analytics Campaign A ${stamp}`,
        status: "active",
        agent_id: agentId,
        goal_id: goalId,
        twilio_number_id: twilioNumberAId,
        calling_hours_start: "00:00:00",
        calling_hours_end: "23:59:59",
      })
      .select("id")
      .single();
    campaignAId = campA!.id;

    const { data: campB } = await admin
      .from("campaigns")
      .insert({
        owner_id: ownerId,
        name: `E2E Analytics Campaign B ${stamp}`,
        status: "active",
        agent_id: agentId,
        goal_id: goalId,
        twilio_number_id: twilioNumberBId,
        calling_hours_start: "00:00:00",
        calling_hours_end: "23:59:59",
      })
      .select("id")
      .single();
    campaignBId = campB!.id;

    // Seed leads and a deterministic outcome mix in the last-30 window.
    const lead1 = await seedLead("01");
    const lead2 = await seedLead("02");
    const lead3 = await seedLead("03");

    // Campaign A: 1 goal_met + 1 voicemail + 1 no_answer, all this week.
    await seedCall({
      leadId: lead1,
      campaignId: campaignAId,
      outcome: "goal_met",
      goalMet: true,
      duration: 180,
      spend: 0.12,
      daysAgo: 1,
      twilioNumberId: twilioNumberAId,
    });
    await seedCall({
      leadId: lead1,
      campaignId: campaignAId,
      outcome: "voicemail",
      goalMet: false,
      duration: 25,
      spend: 0.03,
      daysAgo: 2,
      twilioNumberId: twilioNumberAId,
    });
    await seedCall({
      leadId: lead2,
      campaignId: campaignAId,
      outcome: "no_answer",
      goalMet: false,
      duration: 15,
      spend: 0.02,
      daysAgo: 3,
      twilioNumberId: twilioNumberAId,
    });

    // Campaign B: 1 callback + 1 dnc (both DM-reached, neither goal_met).
    await seedCall({
      leadId: lead3,
      campaignId: campaignBId,
      outcome: "callback",
      goalMet: false,
      duration: 90,
      spend: 0.08,
      daysAgo: 4,
      twilioNumberId: twilioNumberBId,
    });
    await seedCall({
      leadId: lead3,
      campaignId: campaignBId,
      outcome: "dnc",
      goalMet: false,
      duration: 70,
      spend: 0.07,
      daysAgo: 5,
      twilioNumberId: twilioNumberBId,
    });

    // Two calls in the *prior* 30-day window so compare-periods has data.
    await seedCall({
      leadId: lead2,
      campaignId: campaignAId,
      outcome: "goal_met",
      goalMet: true,
      duration: 200,
      spend: 0.15,
      daysAgo: 40,
      twilioNumberId: twilioNumberAId,
    });
    await seedCall({
      leadId: lead2,
      campaignId: campaignAId,
      outcome: "no_answer",
      goalMet: false,
      duration: 10,
      spend: 0.02,
      daysAgo: 50,
      twilioNumberId: twilioNumberAId,
    });
  });

  test.afterAll(async () => {
    if (callIds.length > 0) {
      await admin.from("calls").delete().in("id", callIds);
    }
    if (leadIds.length > 0) {
      await admin.from("leads").delete().in("id", leadIds);
    }
    if (campaignAId) {
      await admin.from("campaigns").delete().eq("id", campaignAId);
    }
    if (campaignBId) {
      await admin.from("campaigns").delete().eq("id", campaignBId);
    }
    if (agentId) await admin.from("agents").delete().eq("id", agentId);
    if (twilioNumberAId)
      await admin.from("twilio_numbers").delete().eq("id", twilioNumberAId);
    if (twilioNumberBId)
      await admin.from("twilio_numbers").delete().eq("id", twilioNumberBId);
    if (goalId) await admin.from("goals").delete().eq("id", goalId);
    if (listId) await admin.from("lists").delete().eq("id", listId);
  });

  test("KPI tiles aggregate across the selected window", async ({ page }) => {
    const from = daysAgoStr(29);
    const to = todayStr();
    await page.goto(
      `/analytics?preset=custom&from=${from}&to=${to}&list=${listId}`,
    );
    // 5 calls in the last-30 window (3 from A, 2 from B).
    const total = page
      .locator('[data-testid="kpi-tile"][data-label="Total calls"]')
      .first();
    await expect(total).toContainText("5");
    // 3 DMs reached: goal_met + callback + dnc.
    const dms = page.locator(
      '[data-testid="kpi-tile"][data-label="DMs reached"]',
    );
    await expect(dms).toContainText("3");
    // 1 Goal Met.
    const goal = page.locator(
      '[data-testid="kpi-tile"][data-label="Goal Met"]',
    );
    await expect(goal).toContainText("1");
    // Funnel renders.
    await expect(page.getByTestId("funnel")).toBeVisible();
    await expect(page.getByTestId("calls-over-time")).toBeVisible();
  });

  test("campaign slicer narrows the dashboard", async ({ page }) => {
    const from = daysAgoStr(29);
    const to = todayStr();
    await page.goto(
      `/analytics?preset=custom&from=${from}&to=${to}&list=${listId}&campaign=${campaignAId}`,
    );
    const total = page
      .locator('[data-testid="kpi-tile"][data-label="Total calls"]')
      .first();
    // Only the 3 calls in Campaign A.
    await expect(total).toContainText("3");
    const goal = page.locator(
      '[data-testid="kpi-tile"][data-label="Goal Met"]',
    );
    await expect(goal).toContainText("1");
  });

  test("compare-periods toggle adds delta badges", async ({ page }) => {
    const from = daysAgoStr(29);
    const to = todayStr();
    await page.goto(
      `/analytics?preset=custom&from=${from}&to=${to}&list=${listId}&compare=1`,
    );
    // At least one delta badge is visible on the tiles.
    const badges = page.getByTestId("kpi-delta");
    expect(await badges.count()).toBeGreaterThan(0);
  });
});
