import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.use({ storageState: "playwright/.auth/user.json" });

test.describe("leads table", () => {
  const stamp = Date.now();
  const company = `E2E Lead Co ${stamp}`;
  const otherCompany = `E2E Other Co ${stamp}`;

  let admin: SupabaseClient;
  let listId: string;
  const leadIds: string[] = [];

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
      .insert({ owner_id: owner!.id, name: `E2E Lead List ${stamp}` })
      .select("id")
      .single();
    listId = list!.id;

    const { data: leads } = await admin
      .from("leads")
      .insert([
        {
          owner_id: owner!.id,
          list_id: listId,
          company,
          business_phone: `+1512000${stamp % 10000}`,
          business_email: `e2e-${stamp}@demo.example`,
          city: "Austin",
          state: "TX",
        },
        {
          owner_id: owner!.id,
          list_id: listId,
          company: otherCompany,
          business_phone: `+1512111${stamp % 10000}`,
          city: "Denver",
          state: "CO",
        },
      ])
      .select("id");
    for (const lead of leads ?? []) leadIds.push(lead.id);
  });

  test.afterAll(async () => {
    if (leadIds.length > 0) {
      await admin.from("leads").delete().in("id", leadIds);
    }
    if (listId) await admin.from("lists").delete().eq("id", listId);
  });

  test("the leads table renders leads and pagination", async ({ page }) => {
    await page.goto("/leads");

    await expect(
      page.getByRole("heading", { level: 1, name: "Leads" }),
    ).toBeVisible();
    await expect(page.getByRole("cell", { name: company })).toBeVisible();
    await expect(page.getByText(/Page 1 of/)).toBeVisible();
  });

  test("search filters the leads table", async ({ page }) => {
    await page.goto("/leads");

    await page
      .getByPlaceholder("Search company, phone, or email")
      .fill(company);
    await page.getByRole("button", { name: "Search" }).click();

    await expect(page.getByRole("cell", { name: company })).toBeVisible();
    await expect(page.getByRole("cell", { name: otherCompany })).toHaveCount(0);
  });
});
