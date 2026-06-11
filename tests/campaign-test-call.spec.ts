import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.use({ storageState: "playwright/.auth/user.json" });

test.describe.configure({ mode: "serial" });

/**
 * Test tab on the campaign settings dialog. It now opens a REAL ElevenLabs
 * browser voice session with the campaign's agent (mic + live convai), so the
 * end-to-end flow can't be driven headlessly. This test just verifies the real
 * test-call UI renders (copy + Start button) instead of the old mock.
 */
test.describe("Campaign test call", () => {
  const stamp = Date.now();
  let admin: SupabaseClient;
  let ownerId: string;
  let agentId: string;
  let goalId: string;
  let campaignId: string;

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
        name: `E2E TestCall Agent ${stamp}`,
        elevenlabs_agent_id: `testcall-agent-${stamp}`,
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
      .insert({ owner_id: ownerId, name: `E2E TestCall Goal ${stamp}` })
      .select("id")
      .single();
    goalId = goal!.id;

    const { data: campaign } = await admin
      .from("campaigns")
      .insert({
        owner_id: ownerId,
        name: `E2E TestCall Campaign ${stamp}`,
        status: "active",
        agent_id: agentId,
        goal_id: goalId,
      })
      .select("id")
      .single();
    campaignId = campaign!.id;
  });

  test.afterAll(async () => {
    await admin
      .from("campaigns")
      .delete()
      .eq("id", campaignId ?? "");
    await admin
      .from("agents")
      .delete()
      .eq("id", agentId ?? "");
    await admin
      .from("goals")
      .delete()
      .eq("id", goalId ?? "");
  });

  test("the real test-call UI renders on the Test tab", async ({ page }) => {
    await page.goto("/campaigns?status=all");
    // The campaign name in the primary cell IS the settings trigger; it sits
    // in an overflow-x-auto table wider than the test viewport, so click via DOM.
    const campaignName = `E2E TestCall Campaign ${stamp}`;
    await page.evaluate((name) => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const target = buttons.find((b) => b.textContent?.trim() === name);
      (target as HTMLButtonElement | undefined)?.click();
    }, campaignName);
    // Expand the Test section in the settings drawer.
    await page.getByTestId("campaign-section-test").locator("summary").click();

    // The real (non-mock) test tab: talk to the campaign's actual agent.
    await expect(
      page.getByText("Talk to this campaign's real agent"),
    ).toBeVisible();
    await expect(page.getByText("Ready to start")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Start test call" }),
    ).toBeVisible();
  });
});
