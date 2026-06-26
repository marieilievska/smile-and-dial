import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.describe.configure({ mode: "serial" });

/**
 * Reporting scope filter (campaign-only):
 *  - The scope picker is present and offers only All + campaign options (no
 *    agent options).
 *  - A campaign WITH sentiment data shows the dashboard's Yes/Maybe/No columns
 *    and the interest tabs (Voice of Customer + Hot Leads).
 *  - A campaign WITHOUT sentiment data hides the dashboard sentiment columns
 *    and the interest tabs; the combined (All) view also hides the sentiment
 *    columns.
 *  - The App Changelog is a read-only table (Date header, no Owner header).
 */
test.describe("Reporting scope filter", () => {
  const stamp = Date.now();
  let admin: SupabaseClient;
  let ownerId: string;
  let agentId: string;
  let goalId: string;
  let leadId: string;
  let interestCampaignId: string;
  let plainCampaignId: string;
  const callIds: string[] = [];

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

    const { data: agent } = await admin
      .from("agents")
      .insert({
        owner_id: ownerId,
        name: `E2E Scope Agent ${stamp}`,
        prompt_personality: "x",
        prompt_environment: "x",
        prompt_tone: "x",
        prompt_goal: "x",
        prompt_guardrails: "x",
      })
      .select("id")
      .single();
    agentId = agent!.id as string;

    const { data: goal } = await admin
      .from("goals")
      .insert({ owner_id: ownerId, name: `E2E Scope Goal ${stamp}` })
      .select("id")
      .single();
    goalId = goal!.id;

    const mkCampaign = async (name: string) => {
      const { data } = await admin
        .from("campaigns")
        .insert({ owner_id: ownerId, agent_id: agentId, goal_id: goalId, name })
        .select("id")
        .single();
      return data!.id as string;
    };
    interestCampaignId = await mkCampaign(`E2E Scope Interest ${stamp}`);
    plainCampaignId = await mkCampaign(`E2E Scope Plain ${stamp}`);

    const { data: lead } = await admin
      .from("leads")
      .insert({
        owner_id: ownerId,
        company: `E2E Scope Co ${stamp}`,
        business_phone: `+1555${String(stamp).slice(-7)}`,
        status: "ready_to_call",
      })
      .select("id")
      .single();
    leadId = lead!.id;

    const insertCall = async (
      campaignId: string,
      extracted: Record<string, unknown> | null,
    ) => {
      const { data } = await admin
        .from("calls")
        .insert({
          lead_id: leadId,
          agent_id: agentId,
          campaign_id: campaignId,
          goal_id: goalId,
          direction: "outbound",
          status: "completed",
          outcome: "completed",
          duration_seconds: 80,
          started_at: new Date().toISOString(),
          extracted_data: extracted,
        })
        .select("id")
        .single();
      callIds.push(data!.id);
    };
    await insertCall(interestCampaignId, { ai_call_answering_interest: "yes" });
    await insertCall(plainCampaignId, {});
  });

  test.afterAll(async () => {
    for (const id of callIds) await admin.from("calls").delete().eq("id", id);
    await admin
      .from("leads")
      .delete()
      .eq("id", leadId ?? "");
    await admin
      .from("campaigns")
      .delete()
      .eq("id", interestCampaignId ?? "");
    await admin
      .from("campaigns")
      .delete()
      .eq("id", plainCampaignId ?? "");
    await admin
      .from("agents")
      .delete()
      .eq("id", agentId ?? "");
    await admin
      .from("goals")
      .delete()
      .eq("id", goalId ?? "");
  });

  test("the picker has no agent options", async ({ page }) => {
    await page.goto("/reporting");
    await expect(page.locator("#reporting-scope")).toBeVisible();
    // No agent-scoped options exist in the campaigns-only picker.
    await expect(
      page.locator('#reporting-scope option[value^="agent:"]'),
    ).toHaveCount(0);
  });

  test("a campaign with sentiment data shows the Yes column + interest tabs", async ({
    page,
  }) => {
    await page.goto(`/reporting?scope=campaign:${interestCampaignId}`);
    await expect(page.locator("#reporting-scope")).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Yes" })).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Voice of Customer" }),
    ).toBeVisible();
  });

  test("a campaign without sentiment data hides the Yes column + interest tabs", async ({
    page,
  }) => {
    await page.goto(`/reporting?scope=campaign:${plainCampaignId}`);
    await expect(page.locator("#reporting-scope")).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Yes" })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("link", { name: "Voice of Customer" }),
    ).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible();
  });

  test("the combined view hides the Yes column", async ({ page }) => {
    await page.goto("/reporting?scope=all");
    await expect(page.getByRole("columnheader", { name: "Yes" })).toHaveCount(
      0,
    );
  });

  test("the App Changelog is a read-only table with no Owner header", async ({
    page,
  }) => {
    await page.goto("/reporting?tab=changelog");
    await expect(
      page.getByRole("columnheader", { name: "Date" }),
    ).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Owner" })).toHaveCount(
      0,
    );
  });
});
