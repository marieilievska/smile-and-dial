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
    await dialog
      .getByRole("button", { name: `Buy ${phone}`, exact: true })
      .click();

    // The dialog stays open so several numbers can be bought in a row; the one
    // we just bought drops out of the results. Close it to return to the table.
    await expect(
      dialog.getByRole("button", { name: `Buy ${phone}`, exact: true }),
    ).toHaveCount(0);
    await dialog.getByRole("button", { name: "Close" }).click();

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

  test("selecting in-pool numbers reveals the bulk move bar", async ({
    page,
  }) => {
    await page.goto("/settings/twilio-numbers");

    // Buy two numbers so there's a selectable pair.
    for (const phone of ["+14155551001", "+14155551002"]) {
      await page.getByRole("button", { name: "Buy number" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Area code").fill("415");
      await dialog.getByRole("button", { name: "Search" }).click();
      await dialog
        .getByRole("button", { name: `Buy ${phone}`, exact: true })
        .click();
      await dialog.getByRole("button", { name: "Close" }).click();
      await expect(
        page.getByRole("row", { name: phone }).getByText("In pool"),
      ).toBeVisible();
    }

    // No bar until something is selected.
    await expect(page.getByText(/\d+ selected/)).toHaveCount(0);

    // Tick both rows' checkboxes.
    await page
      .getByRole("row", { name: "+14155551001" })
      .getByRole("checkbox")
      .check();
    await page
      .getByRole("row", { name: "+14155551002" })
      .getByRole("checkbox")
      .check();

    // The bulk bar appears with the count and a "Move to campaign" control.
    await expect(page.getByText("2 selected")).toBeVisible();
    await expect(
      page.getByRole("combobox", { name: "Move to campaign" }),
    ).toBeVisible();
  });
});
