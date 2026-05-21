import { test, expect } from "@playwright/test";

// These specs run as an authenticated user via the saved session.
test.use({ storageState: "playwright/.auth/user.json" });

const navLabels = [
  "Leads",
  "Calls",
  "Callbacks",
  "Goals",
  "Campaigns",
  "Analytics",
  "DNC",
  "Costs",
  "Settings",
];

test.describe("app shell", () => {
  test("the sidebar shows every navigation item", async ({ page }) => {
    await page.goto("/leads");

    const nav = page.getByRole("navigation");
    for (const label of navLabels) {
      await expect(nav.getByRole("link", { name: label })).toBeVisible();
    }
  });

  test("navigation links route between sections and mark the active item", async ({
    page,
  }) => {
    await page.goto("/leads");
    const nav = page.getByRole("navigation");

    await nav.getByRole("link", { name: "Campaigns" }).click();
    await expect(page).toHaveURL(/\/campaigns$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Campaigns" }),
    ).toBeVisible();
    await expect(nav.getByRole("link", { name: "Campaigns" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    await nav.getByRole("link", { name: "Costs" }).click();
    await expect(page).toHaveURL(/\/costs$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Costs" }),
    ).toBeVisible();
  });

  test("the user menu signs the user out", async ({ page }) => {
    await page.goto("/leads");

    await page.getByRole("button", { name: "Open user menu" }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByLabel("Email")).toBeVisible();
  });
});
