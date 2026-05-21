import { test, expect } from "@playwright/test";

test.describe("custom fields — admin", () => {
  test.use({ storageState: "playwright/.auth/user.json" });

  test("an admin can create, edit, and delete a custom field", async ({
    page,
  }) => {
    const name = `E2E Field ${Date.now()}`;
    const renamed = `${name} edited`;

    await page.goto("/settings/custom-fields");

    // Create.
    await page.getByRole("button", { name: "New field" }).click();
    const createDialog = page.getByRole("dialog");
    await createDialog.getByLabel("Name").fill(name);
    await createDialog.getByRole("button", { name: "Create field" }).click();
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
});

test.describe("custom fields — member", () => {
  test.use({ storageState: "playwright/.auth/member.json" });

  test("a member cannot open the Custom fields page", async ({ page }) => {
    await page.goto("/settings/custom-fields");
    await expect(page).toHaveURL(/\/leads$/);
  });
});
