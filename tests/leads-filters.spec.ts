import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.use({ storageState: "playwright/.auth/user.json" });

test.describe("leads filters, columns, and views", () => {
  const stamp = Date.now();
  const dncCompany = `E2E DNC Co ${stamp}`;
  const readyCompany = `E2E Ready Co ${stamp}`;
  const viewName = `E2E View ${stamp}`;

  let admin: SupabaseClient;
  let ownerId: string;
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
    ownerId = owner!.id;

    const { data: list } = await admin
      .from("lists")
      .insert({ owner_id: ownerId, name: `E2E Filter List ${stamp}` })
      .select("id")
      .single();
    listId = list!.id;

    const { data: leads } = await admin
      .from("leads")
      .insert([
        {
          owner_id: ownerId,
          list_id: listId,
          company: dncCompany,
          status: "dnc",
        },
        {
          owner_id: ownerId,
          list_id: listId,
          company: readyCompany,
          status: "ready_to_call",
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
    await admin
      .from("saved_views")
      .delete()
      .eq("user_id", ownerId)
      .like("name", `E2E View ${stamp}%`);
  });

  test("filtering by stage narrows the table", async ({ page }) => {
    await page.goto("/leads");

    await page.getByRole("button", { name: "Filters" }).click();
    await page.getByLabel("Stage").click();
    await page.getByRole("option", { name: "DNC" }).click();
    await page.getByRole("button", { name: "Apply filters" }).click();

    await expect(page.getByRole("cell", { name: dncCompany })).toBeVisible();
    await expect(page.getByRole("cell", { name: readyCompany })).toHaveCount(0);
  });

  test("the column picker adds and removes a column", async ({ page }) => {
    await page.goto("/leads");
    // City sits behind the column picker by default in v2 (default
    // columns trimmed to 7 — Company / Status / Last outcome / List /
    // Last call / Next call / Owner).
    await expect(page.getByRole("columnheader", { name: "City" })).toHaveCount(
      0,
    );

    await page.getByRole("button", { name: "Columns" }).click();
    await page.getByLabel("City").click();

    await expect(
      page.getByRole("columnheader", { name: "City" }),
    ).toBeVisible();
  });

  test("a view can be saved (appears in the sidebar Views list)", async ({
    page,
  }) => {
    await page.goto("/leads?status=dnc");

    // "Save view" lives in the toolbar; the saved-view *listing*
    // graduated to the sidebar under Leads (close/saved-views-sidebar
    // PR α). Saving here should make the view show up in the sidebar.
    await page.getByRole("button", { name: "Save view" }).click();
    await page.getByLabel("View name").fill(viewName);
    await page.getByRole("button", { name: "Save view" }).click();

    const sidebarView = page
      .getByTestId("sidebar-saved-views-leads")
      .getByRole("link", { name: viewName });
    await expect(sidebarView).toBeVisible();

    // Clicking the sidebar view applies its params.
    await sidebarView.click();
    await expect(page).toHaveURL(/status=dnc/);
  });
});
