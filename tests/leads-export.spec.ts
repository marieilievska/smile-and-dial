import { readFile } from "node:fs/promises";

import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.use({ storageState: "playwright/.auth/user.json" });

test.describe("CSV export", () => {
  const stamp = Date.now();
  const tail = String(stamp).slice(-6);
  const exportCo = `E2E Export Co ${stamp}`;
  const hiddenCo = `E2E Hidden Co ${stamp}`;

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
      .insert({ owner_id: owner!.id, name: `E2E Export List ${stamp}` })
      .select("id")
      .single();
    listId = list!.id;
    await admin.from("leads").insert([
      {
        owner_id: owner!.id,
        list_id: listId,
        company: exportCo,
        business_phone: `+1512${tail}1`,
        city: "Austin",
        state: "TX",
      },
      {
        owner_id: owner!.id,
        list_id: listId,
        company: hiddenCo,
        business_phone: `+1512${tail}2`,
        city: "Reno",
        state: "NV",
      },
    ]);
  });

  test.afterAll(async () => {
    await admin.from("leads").delete().eq("list_id", listId);
    await admin.from("lists").delete().eq("id", listId);
  });

  test("exporting respects the search filter and visible columns", async ({
    page,
  }) => {
    // Search narrows to the Export lead; cols narrows to three columns.
    const search = `Export Co ${stamp}`;
    await page.goto(
      `/leads?q=${encodeURIComponent(search)}&cols=company,phone,city`,
    );
    // v2 — the primary cell now shows company name + phone stacked, so
    // its accessible name is "<company> <phone>". Drop exact:true.
    await expect(
      page.getByRole("cell", { name: exportCo }).first(),
    ).toBeVisible();

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("link", { name: "Export" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("leads.csv");

    const csv = await readFile(await download.path(), "utf8");

    // Only the three chosen columns appear, in table order.
    expect(csv).toContain('"Company","Phone","City"');
    expect(csv).not.toContain('"Email"');

    // The filtered-in lead is exported; the filtered-out lead is not.
    expect(csv).toContain(exportCo);
    expect(csv).not.toContain(hiddenCo);
  });
});
