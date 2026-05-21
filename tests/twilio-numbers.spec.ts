import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

test.use({ storageState: "playwright/.auth/user.json" });

test.describe("Twilio numbers", () => {
  // The mock number search always returns +1415555100X numbers; clear any
  // left behind by an earlier run so the unique phone constraint holds.
  test.beforeAll(async () => {
    const admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    await admin
      .from("twilio_numbers")
      .delete()
      .like("phone_number", "+1415555%");
  });

  test.afterAll(async () => {
    const admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    await admin
      .from("twilio_numbers")
      .delete()
      .like("phone_number", "+1415555%");
  });

  test("an admin can buy a number and release it", async ({ page }) => {
    const phone = "+14155551000";
    await page.goto("/settings/twilio-numbers");

    // Search for numbers and buy one.
    await page.getByRole("button", { name: "Buy number" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Area code").fill("415");
    await dialog.getByRole("button", { name: "Search" }).click();
    await dialog.getByRole("button", { name: `Buy ${phone}` }).click();

    // The number lands in the pool.
    const row = page.getByRole("row", { name: phone });
    await expect(row.getByText("In pool")).toBeVisible();

    // Release it — it stays listed but is marked released.
    await row.getByRole("button", { name: `Release ${phone}` }).click();
    await page.getByRole("button", { name: "Release", exact: true }).click();
    await expect(
      page.getByRole("row", { name: phone }).getByText("Released"),
    ).toBeVisible();
  });
});
