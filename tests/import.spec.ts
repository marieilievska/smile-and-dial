import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.use({ storageState: "playwright/.auth/user.json" });

test.describe("CSV import", () => {
  const stamp = Date.now();
  const tail = String(stamp).slice(-6);
  const company = `E2E Import Co ${stamp}`;
  const mobileCompany = `E2E Mobile Co ${stamp}`;

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

  test("a CSV imports valid leads and blocks mobile numbers", async ({
    page,
  }) => {
    // The mock Twilio Lookup keys off the number prefix:
    // +1700… is mobile (blocked), +1999… is invalid, the rest are landlines.
    const csv =
      "company,business_phone,city,state\n" +
      `${company},+1512${tail}1,Austin,TX\n` +
      `Second ${company},+1512${tail}2,Reno,NV\n` +
      `Third ${company},+1512${tail}3,Dallas,TX\n` +
      `${mobileCompany},+1700${tail}4,Austin,TX\n` +
      `E2E Invalid Co ${stamp},+1999${tail}5,Reno,NV\n`;

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

    // Map step → run the Twilio Lookup analysis.
    await page.getByRole("button", { name: "Review import" }).click();

    // Summary step: 3 valid leads, 1 mobile blocked, 1 invalid.
    await expect(page.getByText(/3 leads ready to import/)).toBeVisible();
    await expect(page.getByText(/1 mobile number skipped/)).toBeVisible();
    await expect(page.getByText(/1 invalid number skipped/)).toBeVisible();

    // The skipped rows are downloadable as an error report.
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download error report" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("import-errors.csv");

    await page.getByRole("button", { name: /Import 3 leads/ }).click();
    await expect(page.getByText("Import complete")).toBeVisible();

    // The valid lead shows up on the Leads page.
    // v3 — search moved to the global top bar; submits on Enter. The
    // primary cell stacks company + phone so cell match isn't exact.
    await page.goto("/leads");
    const search = page.getByRole("search").getByLabel("Search leads");
    await search.fill(company);
    await search.press("Enter");
    await expect(
      page.getByRole("cell", { name: company }).first(),
    ).toBeVisible();

    // The mobile-number lead was blocked and never imported.
    await search.fill(mobileCompany);
    await search.press("Enter");
    await expect(page.getByRole("cell", { name: mobileCompany })).toHaveCount(
      0,
    );
  });
});
