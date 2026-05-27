import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.use({ storageState: "playwright/.auth/user.json" });

test.describe.configure({ mode: "serial" });

/**
 * Test tab on the campaign settings dialog (Step 31 / BUILD_PLAN §17 line
 * 1068). The mock flow walks: idle → connecting → talking (transcript
 * appears) → ended. Live wiring against ElevenLabs convai is a safety-rail
 * item; this test only covers the mock path.
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

  test("mock test call walks idle → connecting → transcript → ended", async ({
    page,
  }) => {
    await page.goto("/campaigns");
    // Open the campaign edit dialog (admins see a row with the campaign).
    await page
      .getByRole("button", { name: `Edit ${`E2E TestCall Campaign ${stamp}`}` })
      .click();
    // The edit dialog is now a drawer with collapsible sections. Expand
    // the Test section.
    await page.getByTestId("campaign-section-test").locator("summary").click();
    await expect(page.getByText("Ready to start")).toBeVisible();

    // Start the mock call.
    await page.getByRole("button", { name: "Start test call" }).click();
    await expect(page.getByText("Connecting…")).toBeVisible();
    // First transcript line appears within a few seconds.
    await expect(
      page.getByText("Hi, this is Sara calling from Referrizer"),
    ).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("On call (mock)")).toBeVisible();

    // Hang up before the auto-end timer fires.
    await page.getByRole("button", { name: "Hang up" }).click();
    await expect(page.getByText("Call ended")).toBeVisible();

    // "Start new test" resets to idle so the button label flips back.
    await page.getByRole("button", { name: "Start new test" }).click();
    await expect(page.getByText("Ready to start")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Start test call" }),
    ).toBeVisible();
  });
});
