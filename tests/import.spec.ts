import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.use({ storageState: "playwright/.auth/user.json" });

test.describe("CSV import", () => {
  const stamp = Date.now();
  const company = `E2E Import Co ${stamp}`;

  let admin: SupabaseClient;
  let listId: string;

  test.beforeAll(async () => {
    admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const { data: owner } = await admin
      .from("profiles")
      .select("id")
      .eq("email", process.env.E2E_TEST_EMAIL ?? "")
      .single();
    const { data: list } = await admin
      .from("lists")
      .insert({ owner_id: owner!.id, name: `E2E Import List ${stamp}` })
      .select("id")
      .single();
    listId = list!.id;
  });

  test.afterAll(async () => {
    await admin.from("leads").delete().eq("list_id", listId);
    await admin.from("lists").delete().eq("id", listId);
  });

  test("a CSV of leads can be imported into a list", async ({ page }) => {
    const csv =
      "company,business_phone,city,state\n" +
      `${company},+1512000${stamp % 10000},Austin,TX\n` +
      `Second ${company},+1512111${stamp % 10000},Reno,NV\n`;

    await page.goto("/leads/import");

    await page.getByLabel("CSV file").setInputFiles({
      name: "leads.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv),
    });

    await page.getByLabel("Import into list").click();
    await page
      .getByRole("option", { name: `E2E Import List ${stamp}` })
      .click();
    await page.getByRole("button", { name: "Continue" }).click();

    await page.getByRole("button", { name: /Import 2 leads/ }).click();
    await expect(page.getByText("Import complete")).toBeVisible();

    // The imported lead shows up on the Leads page.
    await page.goto("/leads");
    await page
      .getByPlaceholder("Search company, phone, or email")
      .fill(company);
    await page.getByRole("button", { name: "Search" }).click();
    await expect(
      page.getByRole("cell", { name: company, exact: true }),
    ).toBeVisible();
  });
});
