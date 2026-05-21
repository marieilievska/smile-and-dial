import { test, expect } from "@playwright/test";

import { signIn } from "./helpers";

test.describe("authentication", () => {
  test("unauthenticated visit to a protected page redirects to login", async ({
    page,
  }) => {
    await page.goto("/leads");

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
  });

  test("a user can sign in and reach the app", async ({ page }) => {
    await signIn(page);

    await expect(
      page.getByRole("navigation").getByRole("link", { name: "Leads" }),
    ).toBeVisible();
  });

  test("invalid credentials show an error", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill("wrong@example.com");
    await page.getByLabel("Password").fill("definitely-not-correct");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });
});
