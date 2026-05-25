import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.use({ storageState: "playwright/.auth/user.json" });

test.describe.configure({ mode: "serial" });

/**
 * Calls page (Step 27a). Read-only table with search, sortable headers,
 * pagination, and the basic filter row (campaign / direction / status /
 * outcome / date range). Detail modal + column picker + saved views land
 * in Steps 27b / 28.
 */
test.describe("Calls page", () => {
  const stamp = Date.now();
  const tail = String(stamp).slice(-6);

  let admin: SupabaseClient;
  let ownerId: string;
  let listId: string;
  let twilioNumberId: string;
  let campaignId: string;
  let otherCampaignId: string;
  let agentId: string;
  let goalId: string;
  const callIds: string[] = [];
  const leadIds: string[] = [];

  async function seedLead(label: string, suffix: string): Promise<string> {
    const { data } = await admin
      .from("leads")
      .insert({
        owner_id: ownerId,
        list_id: listId,
        company: `E2E Calls ${label} ${stamp}`,
        business_phone: `+1444${tail}${suffix}`,
      })
      .select("id")
      .single();
    leadIds.push(data!.id);
    return data!.id;
  }

  async function seedCall(opts: {
    leadId: string;
    campaignId: string;
    direction?: "outbound" | "inbound";
    status?: string;
    outcome?: string | null;
    durationSeconds?: number;
    startedAt?: Date;
    cost?: number;
  }): Promise<string> {
    const { data } = await admin
      .from("calls")
      .insert({
        lead_id: opts.leadId,
        campaign_id: opts.campaignId,
        agent_id: agentId,
        twilio_number_id: twilioNumberId,
        direction: opts.direction ?? "outbound",
        status: opts.status ?? "completed",
        outcome: opts.outcome ?? null,
        duration_seconds: opts.durationSeconds ?? 45,
        talk_time_seconds: 30,
        started_at: (opts.startedAt ?? new Date()).toISOString(),
        ended_at: new Date(
          (opts.startedAt ?? new Date()).getTime() +
            (opts.durationSeconds ?? 45) * 1000,
        ).toISOString(),
        cost_breakdown: { total: opts.cost ?? 0.07 },
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
      .insert({ owner_id: ownerId, name: `E2E Calls List ${stamp}` })
      .select("id")
      .single();
    listId = list!.id;

    const { data: num } = await admin
      .from("twilio_numbers")
      .insert({
        phone_number: `+1444${tail}99`,
        friendly_name: `E2E Calls Number ${stamp}`,
        country: "US",
      })
      .select("id")
      .single();
    twilioNumberId = num!.id;

    const { data: agent } = await admin
      .from("agents")
      .insert({
        owner_id: ownerId,
        name: `E2E Calls Agent ${stamp}`,
        elevenlabs_agent_id: `calls-agent-${stamp}`,
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
      .insert({ owner_id: ownerId, name: `E2E Calls Goal ${stamp}` })
      .select("id")
      .single();
    goalId = goal!.id;

    const { data: cMain } = await admin
      .from("campaigns")
      .insert({
        owner_id: ownerId,
        name: `E2E Calls Main Campaign ${stamp}`,
        status: "active",
        agent_id: agentId,
        goal_id: goalId,
      })
      .select("id")
      .single();
    campaignId = cMain!.id;

    const { data: cOther } = await admin
      .from("campaigns")
      .insert({
        owner_id: ownerId,
        name: `E2E Calls Other Campaign ${stamp}`,
        status: "active",
        agent_id: agentId,
        goal_id: goalId,
      })
      .select("id")
      .single();
    otherCampaignId = cOther!.id;

    // Seed three calls — different outcomes, campaigns, directions — so the
    // filters have something to narrow against.
    const lead1 = await seedLead("Alpha", "10");
    const lead2 = await seedLead("Beta", "11");
    const lead3 = await seedLead("Gamma", "12");
    await seedCall({
      leadId: lead1,
      campaignId,
      outcome: "voicemail",
      durationSeconds: 18,
    });
    await seedCall({
      leadId: lead2,
      campaignId: otherCampaignId,
      outcome: "goal_met",
      durationSeconds: 120,
    });
    await seedCall({
      leadId: lead3,
      campaignId,
      direction: "inbound",
      outcome: "callback",
      durationSeconds: 60,
    });
  });

  test.afterAll(async () => {
    if (callIds.length > 0) {
      await admin.from("calls").delete().in("id", callIds);
    }
    if (leadIds.length > 0) {
      await admin.from("leads").delete().in("id", leadIds);
    }
    await admin
      .from("campaigns")
      .delete()
      .in("id", [campaignId, otherCampaignId].filter(Boolean) as string[]);
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

  test("the page lists seeded calls with their lead, campaign, and outcome", async ({
    page,
  }) => {
    await page.goto(
      `/calls?q=${encodeURIComponent(`E2E Calls Alpha ${stamp}`)}`,
    );
    // The Alpha row shows up; the others don't (filtered by search).
    await expect(
      page.getByRole("cell", { name: `E2E Calls Alpha ${stamp}` }),
    ).toBeVisible();
    await expect(
      page.getByRole("cell", { name: `E2E Calls Beta ${stamp}` }),
    ).toHaveCount(0);
  });

  test("the outcome filter narrows to a single row", async ({ page }) => {
    await page.goto(`/calls?campaign=${campaignId}&outcome=callback`);
    // Of our 3 seeds, only Gamma's outcome=callback under the main campaign.
    const rows = page.locator("tbody tr");
    await expect(rows).toHaveCount(1);
    await expect(
      page.getByRole("cell", { name: `E2E Calls Gamma ${stamp}` }),
    ).toBeVisible();
  });

  test("the direction filter splits inbound vs outbound", async ({ page }) => {
    await page.goto(`/calls?campaign=${campaignId}&direction=inbound`);
    await expect(
      page.getByRole("cell", { name: `E2E Calls Gamma ${stamp}` }),
    ).toBeVisible();
    await expect(
      page.getByRole("cell", { name: `E2E Calls Alpha ${stamp}` }),
    ).toHaveCount(0);

    await page.goto(`/calls?campaign=${campaignId}&direction=outbound`);
    await expect(
      page.getByRole("cell", { name: `E2E Calls Alpha ${stamp}` }),
    ).toBeVisible();
    await expect(
      page.getByRole("cell", { name: `E2E Calls Gamma ${stamp}` }),
    ).toHaveCount(0);
  });

  test("sorting by duration ascending puts the shortest call first", async ({
    page,
  }) => {
    await page.goto(
      `/calls?campaign=${campaignId}&sort=duration_seconds&dir=asc`,
    );
    // Alpha is 18s (voicemail), Gamma is 60s (callback). Alpha first.
    const firstCompanyCell = page.locator("tbody tr td").nth(1);
    await expect(firstCompanyCell).toHaveText(`E2E Calls Alpha ${stamp}`);
  });

  test("an empty-state message renders when no calls match", async ({
    page,
  }) => {
    await page.goto("/calls?q=__no_such_company__");
    await expect(page.getByText("No calls yet")).toBeVisible();
  });
});
