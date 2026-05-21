import { test, expect } from "@playwright/test";

import { signIn } from "./helpers";

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
  // Read-only specs share the saved admin session.
  test.use({ storageState: "playwright/.auth/user.json" });

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
});

test.describe("app shell — sign out", () => {
  // Uses its own fresh session so signing out doesn't revoke the shared one.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("the user menu signs the user out", async ({ page }) => {
    await signIn(page);

    await page.getByRole("button", { name: "Open user menu" }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByLabel("Email")).toBeVisible();
  });
});
