import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

test.use({ storageState: "playwright/.auth/user.json" });

test.describe("goals", () => {
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
    await page.goto("/goals");
    await expect(
      page.getByRole("cell", { name: "Schedule appointment", exact: true }),
    ).toBeVisible();
  });

  test("a user can create, edit, and delete a goal", async ({ page }) => {
    const stamp = Date.now();
    const name = `E2E Goal ${stamp}`;
    const renamed = `E2E Goal ${stamp} updated`;

    await page.goto("/goals");

    // Create.
    await page.getByRole("button", { name: "New goal" }).click();
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page
      .getByLabel("Description", { exact: true })
      .fill("Created by an E2E test.");
    await page.getByRole("button", { name: "Create goal" }).click();
    await expect(page.getByRole("cell", { name, exact: true })).toBeVisible();

    // Edit.
    await page.getByRole("button", { name: `Edit ${name}` }).click();
    await page.getByLabel("Name", { exact: true }).fill(renamed);
    await page.getByRole("button", { name: "Save changes" }).click();
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
