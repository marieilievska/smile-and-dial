import { readFile } from "node:fs/promises";

import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.use({ storageState: "playwright/.auth/user.json" });

test.describe("Leads bulk actions", () => {
  const stamp = Date.now();
  const tail = String(stamp).slice(-6);
  const companyA = `E2E Bulk Co ${stamp} A`;
  const companyB = `E2E Bulk Co ${stamp} B`;
  const companyC = `E2E Bulk Co ${stamp} C`;
  const srcList = `E2E Bulk Src ${stamp}`;
  const destList = `E2E Bulk Dest ${stamp}`;

  let admin: SupabaseClient;
  let srcListId: string;
  let destListId: string;

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
    const { data: src } = await admin
      .from("lists")
      .insert({ owner_id: owner!.id, name: srcList })
      .select("id")
      .single();
    const { data: dest } = await admin
      .from("lists")
      .insert({ owner_id: owner!.id, name: destList })
      .select("id")
      .single();
    srcListId = src!.id;
    destListId = dest!.id;
    await admin.from("leads").insert(
      [companyA, companyB, companyC].map((company, index) => ({
        owner_id: owner!.id,
        list_id: srcListId,
        company,
        business_phone: `+1512${tail}${index}`,
      })),
    );
  });

  test.afterAll(async () => {
    await admin.from("leads").delete().in("list_id", [srcListId, destListId]);
    await admin.from("lists").delete().in("id", [srcListId, destListId]);
  });

  test("select leads, export, move to a list, and delete", async ({ page }) => {
    await page.goto(`/leads?q=${encodeURIComponent(`Bulk Co ${stamp}`)}`);

    // Select two of the three leads.
    await page
      .getByRole("row", { name: companyA })
      .getByLabel("Select lead")
      .click();
    await page
      .getByRole("row", { name: companyB })
      .getByLabel("Select lead")
      .click();
    await expect(page.getByText("2 selected")).toBeVisible();

    // Export selected — only the two chosen leads appear in the CSV.
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export selected" }).click();
    const csv = await readFile(await (await downloadPromise).path(), "utf8");
    expect(csv).toContain(companyA);
    expect(csv).toContain(companyB);
    expect(csv).not.toContain(companyC);

    // Move the two selected leads to the destination list.
    await page.getByRole("button", { name: "Move to list" }).click();
    await page.getByLabel("List").click();
    await page.getByRole("option", { name: destList }).click();
    await page.getByRole("button", { name: "Move" }).click();
    await expect(page.getByRole("cell", { name: destList })).toHaveCount(2);

    // Delete the remaining lead.
    await page
      .getByRole("row", { name: companyC })
      .getByLabel("Select lead")
      .click();
    await page.getByRole("button", { name: "Delete" }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Delete" })
      .click();
    await expect(
      page.getByRole("cell", { name: companyC, exact: true }),
    ).toHaveCount(0);
  });
});
