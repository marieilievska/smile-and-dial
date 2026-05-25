import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.use({ storageState: "playwright/.auth/user.json" });

test.describe.configure({ mode: "serial" });

test.describe("Do not call", () => {
  const stamp = Date.now();
  const tail = String(stamp).slice(-6);
  const phoneA = `+1888${tail}01`;
  const phoneB = `+1888${tail}02`;
  const importPhone1 = `+1888${tail}10`;
  const importPhone2 = `+1888${tail}11`;
  const importPhone3 = `+1888${tail}12`;
  const bulkPhone1 = `+1888${tail}20`;
  const bulkPhone2 = `+1888${tail}21`;
  const bulkPhone3 = `+1888${tail}22`;

  let admin: SupabaseClient;

  test.beforeAll(async () => {
    admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    await admin.from("dnc_entries").delete().like("phone", "+1888%");
    await admin.from("dnc_removals").delete().like("phone", "+1888%");
  });

  test.afterAll(async () => {
    await admin.from("dnc_entries").delete().like("phone", "+1888%");
    await admin.from("dnc_removals").delete().like("phone", "+1888%");
  });

  test("an admin can add, see, and remove a number from DNC", async ({
    page,
  }) => {
    await page.goto("/dnc");

    // Add.
    await page.getByRole("button", { name: "Add number" }).click();
    await page.getByLabel("Phone").fill(phoneA);
    await page.getByLabel("Company").fill("E2E Test Co");
    await page.getByRole("button", { name: "Add to DNC" }).click();
    await expect(
      page.getByRole("cell", { name: phoneA, exact: true }),
    ).toBeVisible();

    // Remove (with reason).
    await page
      .getByRole("button", { name: `Remove ${phoneA} from DNC` })
      .click();
    const removeDialog = page.getByRole("alertdialog");
    await removeDialog
      .getByLabel("Reason")
      .fill("Caller asked to be re-added.");
    await removeDialog
      .getByRole("button", { name: "Remove", exact: true })
      .click();
    await expect(
      page.getByRole("cell", { name: phoneA, exact: true }),
    ).toHaveCount(0);

    // The removal was logged with the reason text we typed. The audit row
    // sometimes lags the action by a moment, so poll until it shows up.
    await expect
      .poll(
        async () => {
          const { data } = await admin
            .from("dnc_removals")
            .select("reason_text")
            .eq("phone", phoneA)
            .maybeSingle();
          return data?.reason_text;
        },
        { timeout: 10_000 },
      )
      .toBe("Caller asked to be re-added.");
  });

  test("the bulk Add to DNC action on the leads page works", async ({
    page,
  }) => {
    // Seed a lead so the bulk action has something to act on.
    const { data: owner } = await admin
      .from("profiles")
      .select("id")
      .eq("email", process.env.E2E_TEST_EMAIL ?? "")
      .single();
    const { data: list } = await admin
      .from("lists")
      .insert({ owner_id: owner!.id, name: `E2E DNC List ${stamp}` })
      .select("id")
      .single();
    const companyName = `E2E DNC Lead ${stamp}`;
    await admin.from("leads").insert({
      owner_id: owner!.id,
      list_id: list!.id,
      company: companyName,
      business_phone: phoneB,
    });

    try {
      await page.goto(`/leads?q=${encodeURIComponent(companyName)}`);
      await page
        .getByRole("row", { name: companyName })
        .getByLabel("Select lead")
        .click();
      await page.getByRole("button", { name: "Add to DNC" }).click();
      // Wait for the action to finish (toast confirms the server returned).
      await expect(page.getByText(/Added .* to DNC\./)).toBeVisible();

      // Verify the number is now on the DNC list.
      await page.goto("/dnc");
      await expect(
        page.getByRole("cell", { name: phoneB, exact: true }),
      ).toBeVisible();
    } finally {
      await admin.from("leads").delete().eq("list_id", list!.id);
      await admin.from("lists").delete().eq("id", list!.id);
    }
  });

  test("a CSV import adds numbers to DNC", async ({ page }) => {
    // Pre-seed one of the rows so we can prove the importer skips
    // already-on-DNC numbers instead of failing the whole batch.
    await admin.from("dnc_entries").insert({
      phone: importPhone2,
      reason: "manual",
      company_snapshot: "Pre-seeded",
    });

    // CSV with: 1 brand-new row, 1 already-on-DNC row, 1 unparseable row.
    const csv =
      "phone,business\n" +
      `${importPhone1},Imported Co A\n` +
      `${importPhone2},Imported Co B\n` +
      `not-a-phone,Imported Co C\n` +
      `${importPhone3},Imported Co D\n`;

    await page.goto("/dnc/import");
    await page.getByLabel("CSV file").setInputFiles({
      name: "dnc.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv),
    });

    // The wizard guesses "phone" and "business" columns — confirm and submit.
    await expect(page.getByText(/^dnc\.csv/)).toBeVisible();
    await page.getByRole("button", { name: "Import", exact: true }).click();
    await expect(page.getByText("Import complete")).toBeVisible();
    await expect(page.getByText(/2 numbers added to DNC/)).toBeVisible();
    await expect(page.getByText(/1 duplicate skipped/)).toBeVisible();
    await expect(
      page.getByText(/1 row skipped \(invalid phone\)/),
    ).toBeVisible();

    // The two brand-new numbers show up on the DNC page with reason "Imported".
    await page.goto("/dnc?reason=imported");
    await expect(
      page.getByRole("cell", { name: importPhone1, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("cell", { name: importPhone3, exact: true }),
    ).toBeVisible();
  });

  test("admin can select rows, export a CSV, and bulk-remove with a reason", async ({
    page,
  }) => {
    // Seed three rows so there's a known selection to act on.
    await admin.from("dnc_entries").insert([
      { phone: bulkPhone1, reason: "manual", company_snapshot: "Bulk Co 1" },
      { phone: bulkPhone2, reason: "manual", company_snapshot: "Bulk Co 2" },
      { phone: bulkPhone3, reason: "manual", company_snapshot: "Bulk Co 3" },
    ]);

    await page.goto("/dnc?reason=manual");

    // Select the first two via their checkboxes.
    await page.getByRole("checkbox", { name: `Select ${bulkPhone1}` }).check();
    await page.getByRole("checkbox", { name: `Select ${bulkPhone2}` }).check();
    await expect(page.getByText("2 selected")).toBeVisible();

    // Export selected — the download CSV contains both rows.
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export selected" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("dnc.csv");
    const csvBody = (await download.createReadStream().then(
      (s) =>
        new Promise<string>((resolve, reject) => {
          const chunks: Buffer[] = [];
          s.on("data", (c: Buffer) => chunks.push(c));
          s.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
          s.on("error", reject);
        }),
    ))!;
    expect(csvBody).toContain(bulkPhone1);
    expect(csvBody).toContain(bulkPhone2);
    expect(csvBody).not.toContain(bulkPhone3);

    // Bulk remove the same two with a shared reason.
    await page.getByRole("button", { name: "Remove from DNC" }).click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByLabel("Reason").fill("Cleaning up duplicates.");
    await dialog.getByRole("button", { name: "Remove", exact: true }).click();

    // Both removed rows disappear; the third stays.
    await expect(
      page.getByRole("cell", { name: bulkPhone1, exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("cell", { name: bulkPhone2, exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("cell", { name: bulkPhone3, exact: true }),
    ).toBeVisible();

    // The audit log has one row per phone (the visibility window can lag a
    // moment, so poll).
    await expect
      .poll(
        async () => {
          const { data } = await admin
            .from("dnc_removals")
            .select("phone, reason_text")
            .in("phone", [bulkPhone1, bulkPhone2]);
          return data?.length ?? 0;
        },
        { timeout: 10_000 },
      )
      .toBe(2);
    const { data: logs } = await admin
      .from("dnc_removals")
      .select("phone, reason_text")
      .in("phone", [bulkPhone1, bulkPhone2]);
    for (const log of logs ?? []) {
      expect(log.reason_text).toBe("Cleaning up duplicates.");
    }
  });

  test("the date-range filter narrows the DNC table", async ({ page }) => {
    // Two future-dated rows shouldn't appear in a filter that ends yesterday.
    const future = `+1888${tail}30`;
    await admin.from("dnc_entries").insert({
      phone: future,
      reason: "manual",
      company_snapshot: "Future Co",
    });

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    await page.goto(`/dnc?to=${yesterday}`);
    await expect(
      page.getByRole("cell", { name: future, exact: true }),
    ).toHaveCount(0);

    // With no date filter, the row is visible.
    await page.goto("/dnc");
    await expect(
      page.getByRole("cell", { name: future, exact: true }),
    ).toBeVisible();
  });
});
