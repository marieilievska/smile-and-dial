import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.use({ storageState: "playwright/.auth/user.json" });

test.describe.configure({ mode: "serial" });

test.describe("List ↔ campaign attachments", () => {
  const stamp = Date.now();
  const listName = `E2E Attach List ${stamp}`;
  const campaignName = `E2E Attach Campaign ${stamp}`;
  const agentName = `E2E Attach Agent ${stamp}`;

  let admin: SupabaseClient;
  let listId: string;
  let campaignId: string;
  let agentId: string;

  test.beforeAll(async () => {
    admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    await admin
      .from("campaigns")
      .delete()
      .like("name", "E2E Attach Campaign %");
    await admin.from("lists").delete().like("name", "E2E Attach List %");
    await admin.from("agents").delete().like("name", "E2E Attach Agent %");

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
    const { data: goal } = await admin
      .from("goals")
      .select("id")
      .eq("name", "Schedule appointment")
      .single();
    const { data: list } = await admin
      .from("lists")
      .insert({ owner_id: owner!.id, name: listName })
      .select("id")
      .single();
    listId = list!.id;
    const { data: campaign } = await admin
      .from("campaigns")
      .insert({
        owner_id: owner!.id,
        name: campaignName,
        agent_id: agentId,
        goal_id: goal!.id,
      })
      .select("id")
      .single();
    campaignId = campaign!.id;
  });

  test.afterAll(async () => {
    await admin.from("campaigns").delete().eq("id", campaignId);
    await admin.from("lists").delete().eq("id", listId);
    await admin.from("agents").delete().eq("id", agentId);
  });

  test("a list can be attached and detached from the Lists row", async ({
    page,
  }) => {
    await page.goto("/settings/lists");
    const row = page.getByRole("row").filter({ hasText: listName });

    // Initially unattached.
    await expect(row).toContainText("—");

    // Attach to the seeded campaign.
    await row
      .getByRole("button", { name: `Attach ${listName} to a campaign` })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("combobox", { name: "Campaign" }).click();
    await page.getByRole("option", { name: campaignName }).click();
    await dialog.getByRole("button", { name: "Attach", exact: true }).click();
    await expect(row).toContainText(campaignName);

    // Detach again.
    await row
      .getByRole("button", {
        name: `Detach ${listName} from ${campaignName}`,
      })
      .click();
    await expect(row).not.toContainText(campaignName);
  });
});
