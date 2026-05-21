import { test, expect } from "@playwright/test";

const adminEmail = process.env.E2E_TEST_EMAIL ?? "";
const memberEmail = process.env.E2E_MEMBER_EMAIL ?? "";

test.describe("users management — admin", () => {
  test.use({ storageState: "playwright/.auth/user.json" });

  test("the Settings nav item opens the Users page", async ({ page }) => {
    await page.goto("/leads");
    await page
      .getByRole("navigation")
      .getByRole("link", { name: "Settings" })
      .click();

    await expect(page).toHaveURL(/\/settings\/users$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Users" }),
    ).toBeVisible();
  });

  test("the users table lists every account", async ({ page }) => {
    await page.goto("/settings/users");

    await expect(page.getByText(adminEmail)).toBeVisible();
    await expect(page.getByText(memberEmail)).toBeVisible();
  });

  test("an admin cannot change their own role or status", async ({ page }) => {
    await page.goto("/settings/users");

    const ownRow = page.getByRole("row").filter({ hasText: adminEmail });
    await ownRow.getByRole("button", { name: /Actions for/ }).click();

    await expect(
      page.getByRole("menuitem", { name: /Make member/ }),
    ).toBeDisabled();
    await expect(
      page.getByRole("menuitem", { name: "Deactivate" }),
    ).toBeDisabled();
  });
});

test.describe("users management — member", () => {
  test.use({ storageState: "playwright/.auth/member.json" });

  test("a member cannot open the Users page", async ({ page }) => {
    await page.goto("/settings/users");
    await expect(page).toHaveURL(/\/leads$/);
  });
});
