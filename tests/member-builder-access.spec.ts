import { test, expect } from "@playwright/test";

/**
 * Contract for the repurposed `member` role (the everyday "builder").
 *
 * Members can now manage phone numbers and custom fields, and reach
 * Integrations — everything they need to build a campaign on their own.
 * Teammates (Users) and API keys stay admin-only. Destructive/compliance
 * actions (delete a custom field, release another teammate's number, remove
 * a number from DNC) stay admin-only via server-side checks + RLS.
 *
 * NOTE: this spec is the behavior contract. It runs against the deployed
 * environment (Playwright is not a local/CI gate here — CI was removed).
 * Do not expect it to run locally. Uses the seeded member session.
 */
test.describe("member (builder) access", () => {
  test.use({ storageState: "playwright/.auth/member.json" });

  test("a member can open Twilio numbers", async ({ page }) => {
    await page.goto("/settings/twilio-numbers");
    await expect(page).toHaveURL(/\/settings\/twilio-numbers$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Twilio numbers" }),
    ).toBeVisible();
    // Management access: at least one "Buy" control is present.
    await expect(
      page.getByRole("button", { name: /Buy/i }).first(),
    ).toBeVisible();
  });

  test("a member can open Custom fields", async ({ page }) => {
    await page.goto("/settings/custom-fields");
    await expect(page).toHaveURL(/\/settings\/custom-fields$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Custom fields" }),
    ).toBeVisible();
  });

  test("a member can open Integrations", async ({ page }) => {
    await page.goto("/settings/integrations");
    await expect(page).toHaveURL(/\/settings\/integrations$/);
  });

  test("a member can open the DNC list", async ({ page }) => {
    await page.goto("/dnc");
    await expect(page).toHaveURL(/\/dnc$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Do not call" }),
    ).toBeVisible();
  });

  test("a member still cannot open the Users page", async ({ page }) => {
    await page.goto("/settings/users");
    await expect(page).toHaveURL(/\/leads$/);
  });

  test("a member still cannot open the API keys page", async ({ page }) => {
    await page.goto("/settings/api");
    // The API page bounces non-admins to Settings, which lands on Overview.
    await expect(page).toHaveURL(/\/settings\/overview$/);
  });
});
