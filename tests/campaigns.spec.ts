import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.use({ storageState: "playwright/.auth/user.json" });

// Tests in this file share an agent/goal and a created campaign — run them in
// one worker so the seed and assertions don't race.
test.describe.configure({ mode: "serial" });

test.describe("Campaigns", () => {
  const stamp = Date.now();
  const campaignName = `E2E Campaign ${stamp}`;
  const renamed = `${campaignName} updated`;
  const agentName = `E2E Campaign Agent ${stamp}`;

  let admin: SupabaseClient;
  let agentId: string;

  test.beforeAll(async () => {
    admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    await admin.from("campaigns").delete().like("name", "E2E Campaign %");
    await admin.from("agents").delete().like("name", "E2E Campaign Agent %");

    const { data: owner } = await admin
      .from("profiles")
      .select("id")
      .eq("email", process.env.E2E_TEST_EMAIL ?? "")
      .single();
    const { data: agent } = await admin
      .from("agents")
      .insert({
        owner_id: owner!.id,
        name: agentName,
        elevenlabs_agent_id: "agent_mock_existing",
      })
      .select("id")
      .single();
    agentId = agent!.id;
  });

  test.afterAll(async () => {
    await admin.from("campaigns").delete().like("name", "E2E Campaign %");
    await admin.from("agents").delete().eq("id", agentId);
  });

  test("an admin can create, edit, and delete a campaign", async ({ page }) => {
    await page.goto("/campaigns");

    // Create — 2-step minimal dialog.
    await page.getByRole("button", { name: "New campaign" }).click();
    const dialog = page.getByRole("dialog");

    // Step 1: name + agent + goal.
    await dialog.getByLabel("Name", { exact: true }).fill(campaignName);
    await dialog.getByRole("combobox", { name: "Agent" }).click();
    await page
      .getByRole("listbox")
      .getByRole("option", { name: agentName, exact: true })
      .click();
    // Default goal "Schedule appointment" is fine — leave it.
    await dialog.getByRole("button", { name: "Continue" }).click();

    // Step 2: skip list attachments and create.
    await dialog.getByRole("button", { name: "Create campaign" }).click();
    await expect(page.getByText("Campaign created.")).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.getByRole("cell", { name: campaignName, exact: true }),
    ).toBeVisible({ timeout: 10_000 });

    // Edit.
    await page.getByRole("button", { name: `Edit ${campaignName}` }).click();
    const editDialog = page.getByRole("dialog");
    await editDialog.getByLabel("Name", { exact: true }).fill(renamed);
    await editDialog.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Campaign updated.")).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.getByRole("cell", { name: renamed, exact: true }),
    ).toBeVisible({ timeout: 10_000 });

    // Delete.
    await page.getByRole("button", { name: `Delete ${renamed}` }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(
      page.getByRole("cell", { name: renamed, exact: true }),
    ).toHaveCount(0, { timeout: 10_000 });
  });

  test("pause, resume, clone, and end a campaign", async ({ page }) => {
    const localStamp = Date.now();
    const lifecycleName = `E2E Campaign lifecycle ${localStamp}`;
    const cloneName = `${lifecycleName} (copy)`;

    // Seed a campaign so the test focuses on the lifecycle UI.
    const { data: owner } = await admin
      .from("profiles")
      .select("id")
      .eq("email", process.env.E2E_TEST_EMAIL ?? "")
      .single();
    const { data: goal } = await admin
      .from("goals")
      .select("id")
      .eq("name", "Schedule appointment")
      .single();
    await admin.from("campaigns").insert({
      owner_id: owner!.id,
      name: lifecycleName,
      agent_id: agentId,
      goal_id: goal!.id,
    });

    await page.goto("/campaigns");
    // Scope to the original row, not the cloned "(copy)" row that appears
    // partway through the test.
    const row = page
      .getByRole("row")
      .filter({ hasText: lifecycleName })
      .filter({ hasNotText: "(copy)" });
    await expect(row.getByText("Active")).toBeVisible();

    // Pause → Paused.
    await row.getByRole("button", { name: `Pause ${lifecycleName}` }).click();
    await expect(row.getByText("Paused")).toBeVisible();

    // Resume → Active.
    await row.getByRole("button", { name: `Resume ${lifecycleName}` }).click();
    await expect(row.getByText("Active")).toBeVisible();

    // Clone — a copy row appears.
    await row.getByRole("button", { name: `Clone ${lifecycleName}` }).click();
    await expect(
      page.getByRole("cell", { name: cloneName, exact: true }),
    ).toBeVisible();

    // End — status flips to Ended and the End button disappears.
    await row.getByRole("button", { name: `End ${lifecycleName}` }).click();
    await page.getByRole("button", { name: "End campaign" }).click();
    await expect(row.getByText("Ended")).toBeVisible();
    await expect(
      row.getByRole("button", { name: `End ${lifecycleName}` }),
    ).toHaveCount(0);
  });

  test("an agent in use by a campaign cannot be deleted", async ({ page }) => {
    const localStamp = Date.now();
    const blockedName = `E2E Campaign blocker ${localStamp}`;

    const { data: owner } = await admin
      .from("profiles")
      .select("id")
      .eq("email", process.env.E2E_TEST_EMAIL ?? "")
      .single();
    const { data: goal } = await admin
      .from("goals")
      .select("id")
      .eq("name", "Schedule appointment")
      .single();
    await admin.from("campaigns").insert({
      owner_id: owner!.id,
      name: blockedName,
      agent_id: agentId,
      goal_id: goal!.id,
    });

    await page.goto("/settings/agents");
    await page.getByRole("button", { name: `Delete ${agentName}` }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();

    // Deletion is blocked — the agent still appears in the list.
    await expect(
      page.getByRole("cell", { name: agentName, exact: true }),
    ).toBeVisible();
  });
});
