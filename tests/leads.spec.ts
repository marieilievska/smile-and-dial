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
    // Smart pagination v2 surfaces "Showing N–M of Total" instead of
    // "Page X of Y" — easier to orient on big lists.
    await expect(page.getByTestId("smart-pagination")).toContainText("Showing");
  });

  test("search filters the leads table", async ({ page }) => {
    await page.goto("/leads");

    // Search moved to the global top bar in v3 and submits on Enter
    // (route.replace to /leads?q=…).
    const search = page.getByRole("search").getByLabel("Search leads");
    await search.fill(company);
    await search.press("Enter");

    await expect(page.getByRole("cell", { name: company })).toBeVisible();
    await expect(page.getByRole("cell", { name: otherCompany })).toHaveCount(0);
  });
});

test.describe("manual resting stamps a wake-up date", () => {
  // Contract for the inline Stage picker: picking "Resting" by hand must set
  // a resting_until (and mirror it into next_call_at), or the nightly
  // expire_resting_leads() job never revives the lead and it rests forever.
  const stamp = Date.now();
  const company = `E2E Rest Co ${stamp}`;

  let admin: SupabaseClient;
  let listId: string;
  let leadId: string;

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
      .insert({ owner_id: owner!.id, name: `E2E Rest List ${stamp}` })
      .select("id")
      .single();
    listId = list!.id;

    const { data: lead } = await admin
      .from("leads")
      .insert({
        owner_id: owner!.id,
        list_id: listId,
        company,
        business_phone: `+1512222${stamp % 10000}`,
        status: "ready_to_call",
      })
      .select("id")
      .single();
    leadId = lead!.id;
  });

  test.afterAll(async () => {
    if (leadId) await admin.from("leads").delete().eq("id", leadId);
    if (listId) await admin.from("lists").delete().eq("id", listId);
  });

  test("picking Resting from the inline picker sets resting_until ~15 days out", async ({
    page,
  }) => {
    await page.goto("/leads");

    // Bring the fresh lead into view, then open its inline Stage picker.
    const search = page.getByRole("search").getByLabel("Search leads");
    await search.fill(company);
    await search.press("Enter");
    const row = page.getByRole("row", { name: company });
    await expect(row).toBeVisible();

    await row.getByTestId("lead-status-trigger").click();
    await page.getByRole("option", { name: "Resting" }).click();
    await expect(page.getByText("Stage updated.")).toBeVisible();

    // Wait for the write to land, then assert the resting shape: status
    // 'resting', a resting_until ~15 days ahead, and next_call_at mirroring it.
    await expect
      .poll(async () => {
        const { data } = await admin
          .from("leads")
          .select("status")
          .eq("id", leadId)
          .single();
        return data?.status;
      })
      .toBe("resting");

    const { data: lead } = await admin
      .from("leads")
      .select("status, resting_until, next_call_at")
      .eq("id", leadId)
      .single();
    expect(lead?.resting_until).not.toBeNull();
    const restingUntil = new Date(lead!.resting_until!).getTime();
    const expected = Date.now() + 15 * 24 * 60 * 60 * 1000;
    expect(Math.abs(restingUntil - expected)).toBeLessThan(120_000);
    expect(lead?.next_call_at).toBe(lead?.resting_until);
  });
});
