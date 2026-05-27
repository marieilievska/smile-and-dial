import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

test.use({ storageState: "playwright/.auth/user.json" });

test.describe("goal definitions", () => {
  // Remove any goals left behind by an earlier interrupted run.
  test.beforeAll(async () => {
    const admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    await admin.from("goals").delete().like("name", "E2E Goal %");
  });

  test("the default goal is seeded", async ({ page }) => {
    // Round 10 — goal definitions live at /settings/goals (was /goals).
    await page.goto("/settings/goals");
    // The name cell AND the Edit/Delete action buttons (aria-labels)
    // both contain "Schedule appointment". Scope to the row that
    // contains the name to disambiguate.
    await expect(
      page.getByRole("row", { name: /Schedule appointment/ }).first(),
    ).toBeVisible();
  });

  test("a user can create, edit, and delete a goal", async ({ page }) => {
    const stamp = Date.now();
    const name = `E2E Goal ${stamp}`;
    const renamed = `E2E Goal ${stamp} updated`;

    await page.goto("/settings/goals");

    // Create.
    await page.getByRole("button", { name: "New goal" }).click();
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page
      .getByLabel("Description", { exact: true })
      .fill("Created by an E2E test.");
    await page.getByRole("button", { name: "Create goal" }).click();
    await expect(
      page.getByRole("row", { name: new RegExp(name) }).first(),
    ).toBeVisible();

    // Edit — Edit/Delete buttons live inside an opacity-0 cluster that
    // becomes visible on row hover. Playwright can still click them
    // because pointer events aren't disabled; we look them up by
    // aria-label.
    await page.getByRole("button", { name: `Edit ${name}` }).click();
    await page.getByLabel("Name", { exact: true }).fill(renamed);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(
      page.getByRole("row", { name: new RegExp(renamed) }).first(),
    ).toBeVisible();

    // Delete.
    await page.getByRole("button", { name: `Delete ${renamed}` }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(
      page.getByRole("row", { name: new RegExp(renamed) }),
    ).toHaveCount(0);
  });
});
