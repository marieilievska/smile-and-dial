import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.use({ storageState: "playwright/.auth/user.json" });

test.describe.configure({ mode: "serial" });

/**
 * Goals pipeline (Step 33 / BUILD_PLAN §5.4). The Goals page now shows
 * per-campaign sections of leads in goal-pipeline statuses, with a
 * dropdown to transition the lead through attended / no_show / sale /
 * closed. Calendly auto-fill (scheduled) is deferred to Phase 8.
 */
test.describe("Goals pipeline", () => {
  const stamp = Date.now();
  const tail = String(stamp).slice(-6);

  let admin: SupabaseClient;
  let ownerId: string;
  let listId: string;
  let agentId: string;
  let goalId: string;
  let campaignId: string;
  let twilioNumberId: string;
  let goalMetLeadId: string;
  let goalMetCallId: string;

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
      .insert({ owner_id: ownerId, name: `E2E Goals List ${stamp}` })
      .select("id")
      .single();
    listId = list!.id;

    const { data: num } = await admin
      .from("twilio_numbers")
      .insert({
        phone_number: `+1999${tail}99`,
        friendly_name: `E2E Goals Number ${stamp}`,
        country: "US",
      })
      .select("id")
      .single();
    twilioNumberId = num!.id;

    const { data: agent } = await admin
      .from("agents")
      .insert({
        owner_id: ownerId,
        name: `E2E Goals Agent ${stamp}`,
        elevenlabs_agent_id: `goals-agent-${stamp}`,
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
      .insert({ owner_id: ownerId, name: `E2E Goals Goal ${stamp}` })
      .select("id")
      .single();
    goalId = goal!.id;

    const { data: campaign } = await admin
      .from("campaigns")
      .insert({
        owner_id: ownerId,
        name: `E2E Goals Campaign ${stamp}`,
        status: "active",
        agent_id: agentId,
        goal_id: goalId,
        twilio_number_id: twilioNumberId,
      })
      .select("id")
      .single();
    campaignId = campaign!.id;

    // Lead currently in goal_met status, with a recent goal_met call
    // pointing at our campaign.
    const { data: lead } = await admin
      .from("leads")
      .insert({
        owner_id: ownerId,
        list_id: listId,
        company: `E2E Goals Lead ${stamp}`,
        business_phone: `+1999${tail}10`,
        status: "goal_met",
      })
      .select("id")
      .single();
    goalMetLeadId = lead!.id;

    const { data: call } = await admin
      .from("calls")
      .insert({
        lead_id: goalMetLeadId,
        campaign_id: campaignId,
        agent_id: agentId,
        twilio_number_id: twilioNumberId,
        direction: "outbound",
        status: "completed",
        outcome: "goal_met",
        outcome_source: "elevenlabs",
        goal_met: true,
      })
      .select("id")
      .single();
    goalMetCallId = call!.id;
  });

  test.afterAll(async () => {
    await admin
      .from("system_events")
      .delete()
      .eq("ref_id", goalMetLeadId ?? "")
      .eq("kind", "goal_transition");
    await admin
      .from("calls")
      .delete()
      .eq("id", goalMetCallId ?? "");
    await admin
      .from("leads")
      .delete()
      .eq("id", goalMetLeadId ?? "");
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

  test("the pipeline section shows the goal_met lead under its campaign", async ({
    page,
  }) => {
    // Round 12+ — /goals defaults to the kanban board, which renders
    // <div> cards (not table cells). Force the table view so the
    // existing cell/row selectors keep working.
    await page.goto("/goals?view=table&status=all");
    await expect(page.getByText(`E2E Goals Campaign ${stamp}`)).toBeVisible();
    await expect(
      page.getByRole("cell", { name: new RegExp(`E2E Goals Lead ${stamp}`) }),
    ).toBeVisible();
  });

  test("changing status moves the lead through the pipeline and audits it", async ({
    page,
  }) => {
    // Default is board now; table view exposes the "Change goal status"
    // dropdown the same way (board uses the same component too).
    await page.goto("/goals?view=table&status=all");
    await page
      .getByRole("row", { name: new RegExp(`E2E Goals Lead ${stamp}`) })
      .getByRole("button", { name: "Change goal status" })
      .click();
    await page.getByRole("menuitem", { name: "Attended" }).click();
    await expect(page.getByText("Marked Attended.")).toBeVisible();

    const { data: lead } = await admin
      .from("leads")
      .select("status")
      .eq("id", goalMetLeadId)
      .single();
    expect(lead?.status).toBe("attended");

    const { data: events } = await admin
      .from("system_events")
      .select("kind, payload, actor_user_id")
      .eq("ref_id", goalMetLeadId)
      .eq("kind", "goal_transition");
    expect((events ?? []).length).toBeGreaterThanOrEqual(1);
    expect(events![0].payload).toMatchObject({
      from: "goal_met",
      to: "attended",
    });
    expect(events![0].actor_user_id).toBe(ownerId);
  });
});
