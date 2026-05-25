import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.use({ storageState: "playwright/.auth/user.json" });

test.describe("Agent builder", () => {
  const stamp = Date.now();
  const agentName = `E2E Agent ${stamp}`;
  const kbName = `E2E Agent KB ${stamp}`;

  let admin: SupabaseClient;
  let kbId: string;

  test.beforeAll(async () => {
    admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    // Wipe leftover agents from earlier interrupted runs.
    await admin.from("agents").delete().like("name", "E2E Agent %");

    // Make sure the voice picker has options.
    await admin
      .from("app_settings")
      .update({ elevenlabs_voice_ids: "voice_test_a,voice_test_b" })
      .eq("id", 1);

    // Seed a knowledge base for the KB picker step.
    const { data: owner } = await admin
      .from("profiles")
      .select("id")
      .eq("email", process.env.E2E_TEST_EMAIL ?? "")
      .single();
    const { data: kb } = await admin
      .from("knowledge_bases")
      .insert({ owner_id: owner!.id, name: kbName })
      .select("id")
      .single();
    kbId = kb!.id;
  });

  test.afterAll(async () => {
    await admin.from("agents").delete().eq("name", agentName);
    await admin.from("knowledge_bases").delete().eq("id", kbId);
  });

  test("an admin can build an agent through the wizard", async ({ page }) => {
    await page.goto("/settings/agents/new");

    // Step 1 — Basics.
    await page.getByLabel("Name", { exact: true }).fill(agentName);
    await page.getByRole("button", { name: "Next" }).click();

    // Steps 2–6 — prompt blocks.
    await page
      .getByLabel("Personality", { exact: true })
      .fill("Friendly and direct.");
    await page.getByRole("button", { name: "Next" }).click();

    await page
      .getByLabel("Environment", { exact: true })
      .fill("Outbound calls during business hours.");
    await page.getByRole("button", { name: "Next" }).click();

    await page.getByLabel("Tone", { exact: true }).fill("Concise and warm.");
    await page.getByRole("button", { name: "Next" }).click();

    await page
      .getByLabel("Goal", { exact: true })
      .fill("Get the lead to schedule an appointment.");
    await page.getByRole("button", { name: "Next" }).click();

    await page
      .getByLabel("Guardrails", { exact: true })
      .fill("Never promise pricing.");
    await page.getByRole("button", { name: "Next" }).click();

    // Step 7 — Tools.
    await page.getByLabel("Schedule a callback").check();
    await page.getByRole("button", { name: "Next" }).click();

    // Step 8 — Knowledge base.
    await page.getByLabel(kbName).check();
    await page.getByRole("button", { name: "Next" }).click();

    // Step 9 — Review.
    const prompt = page.getByLabel("System prompt");
    await expect(prompt).toContainText("# Personality");
    await expect(prompt).toContainText("Friendly and direct.");
    await page.getByRole("button", { name: "Save agent" }).click();

    // Lands back on the Agents page.
    await expect(page).toHaveURL(/\/settings\/agents$/);

    // The DB has the saved agent with the right shape, including the
    // (mocked) ElevenLabs agent id from the sync step.
    const { data: agent } = await admin
      .from("agents")
      .select(
        "name, tools_enabled, knowledge_base_ids, system_prompt, prompt_personality, elevenlabs_agent_id",
      )
      .eq("name", agentName)
      .single();
    expect(agent?.prompt_personality).toBe("Friendly and direct.");
    expect(agent?.tools_enabled).toMatchObject({ schedule_callback: true });
    expect(agent?.knowledge_base_ids).toContain(kbId);
    expect(agent?.elevenlabs_agent_id).toMatch(/^agent_mock_/);
    expect(agent?.system_prompt).toContain("Friendly and direct.");
  });
});
