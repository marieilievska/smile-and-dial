import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.use({ storageState: "playwright/.auth/user.json" });

test.describe.configure({ mode: "serial" });

/**
 * Goal-rate redesign (fix/analytics-goal-rate-dm-capture).
 *
 * Locks in the fix for the "Goal rate stuck at 100%" bug:
 *  - "Goals met" and "Goals met · decision-makers" are two SEPARATE fields.
 *  - There is no single "Goal rate" (goals ÷ decision-makers) tile any more.
 *  - The funnel ends at "Decision-makers reached" — goals are not a funnel step,
 *    so no step can read >100%.
 *
 * The page reads each lead's sticky decision_maker_reached flag, so the seed
 * sets that flag directly (what the post-call webhook now does — including for a
 * not_interested call, covered separately in elevenlabs-post-call.spec.ts).
 */
test.describe("Analytics goal split", () => {
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

  async function seedLead(suffix: string, dmReached: boolean): Promise<string> {
    const { data } = await admin
      .from("leads")
      .insert({
        owner_id: ownerId,
        list_id: listId,
        company: `E2E GoalSplit Lead ${stamp}-${suffix}`,
        business_phone: `+1667${tail}${suffix}`,
        timezone: "America/New_York",
        status: "ready_to_call",
        decision_maker_reached: dmReached,
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
  }) {
    const started = new Date();
    started.setUTCDate(started.getUTCDate() - 1);
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
        ended_at: new Date(started.getTime() + 120_000).toISOString(),
        duration_seconds: 120,
        talk_time_seconds: 90,
        cost_breakdown: { twilio: 0.05, elevenlabs: 0.05, total: 0.1 },
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
      .insert({ owner_id: ownerId, name: `E2E GoalSplit List ${stamp}` })
      .select("id")
      .single();
    listId = list!.id;

    const { data: num } = await admin
      .from("twilio_numbers")
      .insert({
        phone_number: `+1667${tail}99`,
        friendly_name: `E2E GoalSplit Num ${stamp}`,
        country: "US",
      })
      .select("id")
      .single();
    twilioNumberId = num!.id;

    const { data: agent } = await admin
      .from("agents")
      .insert({
        owner_id: ownerId,
        name: `E2E GoalSplit Agent ${stamp}`,
        elevenlabs_agent_id: `goalsplit-agent-${stamp}`,
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
      .insert({ owner_id: ownerId, name: `E2E GoalSplit Goal ${stamp}` })
      .select("id")
      .single();
    goalId = goal!.id;

    const { data: campaign } = await admin
      .from("campaigns")
      .insert({
        owner_id: ownerId,
        name: `E2E GoalSplit Campaign ${stamp}`,
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

    // Lead A: goal met AND decision-maker reached.
    const leadA = await seedLead("01", true);
    await seedCall({ leadId: leadA, outcome: "goal_met", goalMet: true });
    // Lead B: goal met WITHOUT reaching the decision-maker.
    const leadB = await seedLead("02", false);
    await seedCall({ leadId: leadB, outcome: "goal_met", goalMet: true });
    // Lead C: reached the decision-maker (not_interested), no goal met.
    const leadC = await seedLead("03", true);
    await seedCall({
      leadId: leadC,
      outcome: "not_interested",
      goalMet: false,
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

  test("shows goals met total and the decision-maker subset as two fields", async ({
    page,
  }) => {
    await page.goto(
      `/analytics?preset=custom&from=${daysAgoStr(29)}&to=${todayStr()}&list=${listId}&compare=0`,
    );

    // Two goal met = leads A and B.
    await expect(
      page.locator('[data-testid="kpi-tile"][data-label="Goals met"]'),
    ).toContainText("2");
    // One of them (lead A) also reached the decision-maker.
    await expect(
      page.locator(
        '[data-testid="kpi-tile"][data-label="Goals met · decision-makers"]',
      ),
    ).toContainText("1");

    // The old single "Goal rate" (goals ÷ decision-makers) tile is gone.
    await expect(
      page.locator('[data-testid="kpi-tile"][data-label="Goal rate"]'),
    ).toHaveCount(0);
  });

  test("funnel ends at decision-makers, with no goals step over 100%", async ({
    page,
  }) => {
    await page.goto(
      `/analytics?preset=custom&from=${daysAgoStr(29)}&to=${todayStr()}&list=${listId}&compare=0`,
    );
    const funnel = page.getByTestId("analytics-funnel");
    await expect(funnel).toContainText("Decision-makers reached");
    // Goals met is reported beside the funnel, not as a funnel stage.
    await expect(funnel).not.toContainText("Goals met");
    // Decision-maker reached = leads A + C, so the rate is real, not 0.
    await expect(
      page.locator(
        '[data-testid="kpi-tile"][data-label="Decision-maker rate"]',
      ),
    ).not.toContainText("0.0%");
  });
});
