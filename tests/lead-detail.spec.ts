import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.use({ storageState: "playwright/.auth/user.json" });

test.describe("Lead detail modal", () => {
  const stamp = Date.now();
  const tail = String(stamp).slice(-6);
  const company = `E2E Detail Co ${stamp}`;
  const fieldName = `E2E Note ${stamp}`;
  const newCity = `Springfield ${stamp}`;
  const customValue = `Custom value ${stamp}`;

  let admin: SupabaseClient;
  let listId: string;
  let customFieldId: string;

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
      .insert({ owner_id: owner!.id, name: `E2E Detail List ${stamp}` })
      .select("id")
      .single();
    listId = list!.id;
    await admin.from("leads").insert({
      owner_id: owner!.id,
      list_id: listId,
      company,
      business_phone: `+1512${tail}1`,
      city: "Austin",
      state: "TX",
    });
    const { data: field } = await admin
      .from("custom_field_defs")
      .insert({
        name: fieldName,
        slug: `e2e_note_${stamp}`,
        type: "text",
        sort_order: 999,
      })
      .select("id")
      .single();
    customFieldId = field!.id;
  });

  test.afterAll(async () => {
    await admin.from("leads").delete().eq("list_id", listId);
    await admin.from("custom_field_defs").delete().eq("id", customFieldId);
    await admin.from("lists").delete().eq("id", listId);
  });

  test("editing a standard and a custom field autosaves", async ({ page }) => {
    await page.goto(`/leads?q=${encodeURIComponent(company)}`);
    // v2 — the primary cell stacks company name + phone, so its
    // accessible name now includes the phone. Drop exact:true.
    await page.getByRole("cell", { name: company }).first().click();

    // Clicking a row navigates to the lead's full detail route now
    // (Close-style /leads/<id>) instead of opening a modal.
    await expect(page).toHaveURL(/\/leads\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { name: company })).toBeVisible();

    // City lives inside the collapsed "Address" section (renamed from
    // "Location & web" in v2) — expand it.
    await page.getByTestId("lead-section-address").locator("summary").click();
    const cityInput = page.getByLabel("City");
    await cityInput.fill(newCity);
    await cityInput.blur();

    // Custom field section also starts collapsed; expand and edit.
    await page
      .getByTestId("lead-section-custom-fields")
      .locator("summary")
      .click();
    const customInput = page.getByLabel(fieldName);
    await customInput.fill(customValue);
    await customInput.blur();

    await expect(page.getByText("Saved")).toBeVisible();

    // Back to the leads list; the table reflects the saved city. City
    // isn't a default column in v2 — opt it in via ?cols=.
    await page.goto(
      "/leads?cols=company,status,city&q=" + encodeURIComponent(company),
    );
    await expect(page).toHaveURL(/\/leads/);
    await expect(page.getByRole("cell", { name: newCity })).toBeVisible();

    // Reopening the lead shows the saved custom value (section starts
    // collapsed on each navigation).
    // v2 — the primary cell stacks company name + phone, so its
    // accessible name now includes the phone. Drop exact:true.
    await page.getByRole("cell", { name: company }).first().click();
    await expect(page).toHaveURL(/\/leads\/[0-9a-f-]{36}$/);
    await page
      .getByTestId("lead-section-custom-fields")
      .locator("summary")
      .click();
    await expect(page.getByLabel(fieldName)).toHaveValue(customValue);
  });
});
