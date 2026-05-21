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
    await page.getByRole("cell", { name: company, exact: true }).click();

    // The modal opens with the lead's fields.
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(company)).toBeVisible();

    // Edit a standard field; it saves when it loses focus.
    const cityInput = dialog.getByLabel("City");
    await cityInput.fill(newCity);
    await cityInput.blur();

    // Edit the custom field too.
    const customInput = dialog.getByLabel(fieldName);
    await customInput.fill(customValue);
    await customInput.blur();

    await expect(dialog.getByText("Saved")).toBeVisible();

    // Close the modal; the table reflects the saved city.
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("cell", { name: newCity, exact: true }),
    ).toBeVisible();

    // Reopening the lead shows the saved custom value.
    await page.getByRole("cell", { name: company, exact: true }).click();
    await expect(page.getByRole("dialog").getByLabel(fieldName)).toHaveValue(
      customValue,
    );
  });
});
