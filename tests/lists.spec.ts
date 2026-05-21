import { test, expect } from "@playwright/test";

test.use({ storageState: "playwright/.auth/user.json" });

test.describe("lists", () => {
  test("a user can create, edit, and delete a list", async ({ page }) => {
    const name = `E2E List ${Date.now()}`;
    const renamed = `${name} edited`;

    await page.goto("/settings/lists");

    // Create.
    await page.getByRole("button", { name: "New list" }).click();
    const createDialog = page.getByRole("dialog");
    await createDialog.getByLabel("Name").fill(name);
    await createDialog.getByRole("button", { name: "Create list" }).click();
    await expect(page.getByRole("cell", { name, exact: true })).toBeVisible();

    // Edit.
    await page.getByRole("button", { name: `Edit ${name}` }).click();
    const editDialog = page.getByRole("dialog");
    await editDialog.getByLabel("Name").fill(renamed);
    await editDialog.getByRole("button", { name: "Save changes" }).click();
    await expect(
      page.getByRole("cell", { name: renamed, exact: true }),
    ).toBeVisible();

    // Delete.
    await page.getByRole("button", { name: `Delete ${renamed}` }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Delete" })
      .click();
    await expect(
      page.getByRole("cell", { name: renamed, exact: true }),
    ).toHaveCount(0);
  });

  test("the Lists tab is reachable from Settings", async ({ page }) => {
    await page.goto("/settings/users");
    await page
      .getByRole("navigation", { name: "Settings" })
      .getByRole("link", { name: "Lists" })
      .click();
    await expect(page).toHaveURL(/\/settings\/lists$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Lists" }),
    ).toBeVisible();
  });
});
