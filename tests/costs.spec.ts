import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.use({ storageState: "playwright/.auth/user.json" });

test.describe.configure({ mode: "serial" });

/**
 * Costs page (Step 36 / BUILD_PLAN §5.8).
 *
 * Coverage:
 *  - Per-campaign view aggregates total + avg/call + cost/Goal Met
 *  - Per-vendor view splits spend across Twilio / 11Labs / OpenAI / Lookup
 *  - View tabs survive the slicer (campaign filter narrows the rollups)
 *
 * Budget-cap configuration already lives on the campaign-settings dialog
 * (Phase 5b). Auto-pause is covered by spend-cap-monitor.spec.ts.
 */
test.describe("Costs page", () => {
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
        company: `E2E Costs Lead ${stamp}-${suffix}`,
        business_phone: `+1444${tail}${suffix}`,
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
    outcome: string;
    goalMet: boolean;
    daysAgo: number;
    breakdown: {
      twilio: number;
      elevenlabs: number;
      openai: number;
      lookup: number;
    };
  }) {
    const total =
      opts.breakdown.twilio +
      opts.breakdown.elevenlabs +
      opts.breakdown.openai +
      opts.breakdown.lookup;
    const started = new Date();
    started.setUTCDate(started.getUTCDate() - opts.daysAgo);
    const { data } = await admin
      .from("calls")
      .insert({
        lead_id: opts.leadId,
        campaign_id: campaignId,
        agent_id: agentId,
        twilio_number_id: twilioNumberId,
        direction: "outbound",
        status: "completed",
        outcome: opts.outcome,
        outcome_source: "twilio",
        goal_met: opts.goalMet,
        started_at: started.toISOString(),
        ended_at: new Date(started.getTime() + 60_000).toISOString(),
        duration_seconds: 60,
        talk_time_seconds: 60,
        cost_breakdown: { ...opts.breakdown, total },
        created_at: started.toISOString(),
      })
      .select("id")
      .single();
    callIds.push(data!.id);
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
      .insert({ owner_id: ownerId, name: `E2E Costs List ${stamp}` })
      .select("id")
      .single();
    listId = list!.id;

    const { data: num } = await admin
      .from("twilio_numbers")
      .insert({
        phone_number: `+1444${tail}77`,
        friendly_name: `E2E Costs Number ${stamp}`,
        country: "US",
      })
      .select("id")
      .single();
    twilioNumberId = num!.id;

    const { data: agent } = await admin
      .from("agents")
      .insert({
        owner_id: ownerId,
        name: `E2E Costs Agent ${stamp}`,
        elevenlabs_agent_id: `costs-agent-${stamp}`,
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
      .insert({ owner_id: ownerId, name: `E2E Costs Goal ${stamp}` })
      .select("id")
      .single();
    goalId = goal!.id;

    const { data: campaign } = await admin
      .from("campaigns")
      .insert({
        owner_id: ownerId,
        name: `E2E Costs Campaign ${stamp}`,
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

    const lead1 = await seedLead("01");
    const lead2 = await seedLead("02");
    // Three calls in the last 30 days, deterministic costs:
    //   total spend = 0.10 + 0.20 + 0.30 = 0.60
    //   twilio     = 0.05 + 0.10 + 0.15 = 0.30
    //   elevenlabs = 0.05 + 0.10 + 0.15 = 0.30
    //   1 goal_met → cost/Goal Met = 0.60.
    await seedCall({
      leadId: lead1,
      outcome: "goal_met",
      goalMet: true,
      daysAgo: 1,
      breakdown: { twilio: 0.05, elevenlabs: 0.05, openai: 0, lookup: 0 },
    });
    await seedCall({
      leadId: lead1,
      outcome: "voicemail",
      goalMet: false,
      daysAgo: 2,
      breakdown: { twilio: 0.1, elevenlabs: 0.1, openai: 0, lookup: 0 },
    });
    await seedCall({
      leadId: lead2,
      outcome: "no_answer",
      goalMet: false,
      daysAgo: 3,
      breakdown: { twilio: 0.15, elevenlabs: 0.15, openai: 0, lookup: 0 },
    });
  });

  test.afterAll(async () => {
    if (callIds.length > 0)
      await admin.from("calls").delete().in("id", callIds);
    if (leadIds.length > 0)
      await admin.from("leads").delete().in("id", leadIds);
    if (campaignId) await admin.from("campaigns").delete().eq("id", campaignId);
    if (agentId) await admin.from("agents").delete().eq("id", agentId);
    if (twilioNumberId)
      await admin.from("twilio_numbers").delete().eq("id", twilioNumberId);
    if (goalId) await admin.from("goals").delete().eq("id", goalId);
    if (listId) await admin.from("lists").delete().eq("id", listId);
  });

  test("per-campaign view shows total + avg per call + cost per Goal Met", async ({
    page,
  }) => {
    const from = daysAgoStr(29);
    const to = todayStr();
    await page.goto(
      `/costs?view=per_campaign&preset=custom&from=${from}&to=${to}&list=${listId}&campaign=${campaignId}`,
    );
    const table = page.getByTestId("per-campaign-table");
    await expect(table).toBeVisible();
    await expect(table).toContainText("$0.60"); // total spend
    await expect(table).toContainText("$0.20"); // avg / call (0.60 / 3)
  });

  test("per-vendor view splits spend across Twilio / 11Labs", async ({
    page,
  }) => {
    const from = daysAgoStr(29);
    const to = todayStr();
    await page.goto(
      `/costs?view=per_vendor&preset=custom&from=${from}&to=${to}&list=${listId}&campaign=${campaignId}`,
    );
    const chart = page.getByTestId("per-vendor-chart");
    await expect(chart).toBeVisible();
    await expect(chart).toContainText("Twilio");
    await expect(chart).toContainText("ElevenLabs");
    // $0.30 each for Twilio and 11Labs.
    await expect(chart).toContainText("$0.30");
    await expect(chart).toContainText("Total across vendors: $0.60");
  });

  test("view tabs are clickable and switch the rendered view", async ({
    page,
  }) => {
    const from = daysAgoStr(29);
    const to = todayStr();
    await page.goto(
      `/costs?view=per_campaign&preset=custom&from=${from}&to=${to}&list=${listId}&campaign=${campaignId}`,
    );
    await page.getByRole("link", { name: "Per goal met" }).click();
    await expect(page.getByTestId("per-goal-table")).toBeVisible();
    await expect(page.getByTestId("per-goal-table")).toContainText("$0.60");
  });
});
