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

    // Create.
    await page.getByRole("button", { name: "New campaign" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name", { exact: true }).fill(campaignName);

    // Pick our seeded agent.
    await dialog.getByRole("tab", { name: "Agent" }).click();
    await dialog.getByRole("combobox", { name: "Agent" }).click();
    await page.getByRole("option", { name: agentName }).click();

    // The seeded default goal ("Schedule appointment") is fine as-is.
    await dialog.getByRole("button", { name: "Create campaign" }).click();
    await expect(
      page.getByRole("cell", { name: campaignName, exact: true }),
    ).toBeVisible();

    // Edit.
    await page.getByRole("button", { name: `Edit ${campaignName}` }).click();
    const editDialog = page.getByRole("dialog");
    await editDialog.getByLabel("Name", { exact: true }).fill(renamed);
    await editDialog.getByRole("button", { name: "Save changes" }).click();
    await expect(
      page.getByRole("cell", { name: renamed, exact: true }),
    ).toBeVisible();

    // Delete.
    await page.getByRole("button", { name: `Delete ${renamed}` }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(
      page.getByRole("cell", { name: renamed, exact: true }),
    ).toHaveCount(0);
  });
});
