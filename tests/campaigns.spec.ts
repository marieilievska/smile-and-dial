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
    // Round 14 — /campaigns now defaults to the Active status tab.
    // Newly-created campaigns are Active so they show on the default
    // tab; this URL is here to be explicit (and to make the lifecycle
    // test below work without changing tabs).
    await page.goto("/campaigns?status=all");

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
    // Round 14 — the campaign name renders as a <button> (the
    // settings-sheet trigger). `toBeAttached` instead of
    // `toBeVisible` because table-fixed + sticky-right actions push
    // the table wider than the viewport in test contexts — the row
    // exists and is interactive but Playwright reports it hidden.
    await expect(
      page.getByRole("button", { name: campaignName, exact: true }),
    ).toBeAttached({ timeout: 10_000 });

    // Edit — the campaign name in the primary cell IS the trigger
    // that opens the settings sheet (round 14 — replaced the dedicated
    // "Edit" hover button). The trigger sits inside an
    // overflow-x-auto table that's wider than the test viewport, so
    // we dispatch click via DOM directly to skip Playwright's
    // viewport check.
    await page.evaluate((name) => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const target = buttons.find((b) => b.textContent?.trim() === name);
      (target as HTMLButtonElement | undefined)?.click();
    }, campaignName);
    const editDialog = page.getByRole("dialog");
    await editDialog.getByLabel("Name", { exact: true }).fill(renamed);
    await editDialog.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Campaign updated.")).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.getByRole("button", { name: renamed, exact: true }),
    ).toBeAttached({ timeout: 10_000 });

    // Delete. The Delete button is in a hover-only opacity-0 cluster
    // inside the sticky-right actions cell — dispatch its click via
    // DOM to bypass both hover state and viewport positioning.
    await page.evaluate((label) => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const target = buttons.find(
        (b) => b.getAttribute("aria-label") === `Delete ${label}`,
      );
      (target as HTMLButtonElement | undefined)?.click();
    }, renamed);
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(
      page.getByRole("button", { name: renamed, exact: true }),
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

    // Round 14 — default tab is Active; lifecycle ends with Ended,
    // so use ?status=all to keep the row visible through every state.
    // Round (campaigns modernize) — /campaigns now defaults to the
    // board (card) view; this lifecycle test asserts on table `row`
    // semantics, so pin it to ?view=table.
    await page.goto("/campaigns?status=all&view=table");
    // Scope to the original row, not the cloned "(copy)" row that
    // appears partway through the test. The row's accessible name
    // includes phone+description etc, so match on hasText.
    const row = page
      .getByRole("row")
      .filter({ hasText: lifecycleName })
      .filter({ hasNotText: "(copy)" });
    await expect(row.getByText("Active")).toBeVisible();

    // Round 14 — row actions live inside a hover-only cluster in a
    // sticky-right cell. Click via DOM by aria-label so the test
    // bypasses both the opacity-0 default and the viewport
    // positioning of the wide table.
    async function clickRowAction(label: string) {
      await page.evaluate((aria) => {
        const buttons = Array.from(document.querySelectorAll("button"));
        const target = buttons.find(
          (b) => b.getAttribute("aria-label") === aria,
        );
        (target as HTMLButtonElement | undefined)?.click();
      }, label);
    }

    // Pause → Paused.
    await clickRowAction(`Pause ${lifecycleName}`);
    await expect(row.getByText("Paused")).toBeVisible();

    // Resume → Active.
    await clickRowAction(`Resume ${lifecycleName}`);
    await expect(row.getByText("Active")).toBeVisible();

    // Clone — a copy row appears.
    await clickRowAction(`Clone ${lifecycleName}`);
    await expect(
      page.getByRole("button", { name: cloneName, exact: true }),
    ).toBeAttached();

    // End — status flips to Ended and the End button disappears.
    await clickRowAction(`End ${lifecycleName}`);
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
