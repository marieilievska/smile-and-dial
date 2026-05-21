import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.use({ storageState: "playwright/.auth/user.json" });

test.describe("Lead detail panels", () => {
  const stamp = Date.now();
  const tail = String(stamp).slice(-6);
  const company = `E2E Panels Co ${stamp}`;
  const listName = `E2E Panels List ${stamp}`;
  const summary = `Rolling summary for ${stamp}.`;

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
      .insert({ owner_id: owner!.id, name: listName })
      .select("id")
      .single();
    listId = list!.id;
    await admin.from("leads").insert({
      owner_id: owner!.id,
      list_id: listId,
      company,
      business_phone: `+1512${tail}1`,
      ai_summary: summary,
    });
  });

  test.afterAll(async () => {
    await admin.from("leads").delete().eq("list_id", listId);
    await admin.from("lists").delete().eq("id", listId);
  });

  test("the modal shows AI summary, pipeline context, and activity", async ({
    page,
  }) => {
    await page.goto(`/leads?q=${encodeURIComponent(company)}`);
    await page.getByRole("cell", { name: company, exact: true }).click();

    const dialog = page.getByRole("dialog");

    // AI summary section shows the rolling summary.
    await expect(dialog.getByText("AI summary")).toBeVisible();
    await expect(dialog.getByText(summary)).toBeVisible();

    // Campaign & list section shows the list and pipeline status.
    await expect(dialog.getByText("Campaign & list")).toBeVisible();
    await expect(dialog.getByText(listName)).toBeVisible();
    await expect(dialog.getByText("Ready to call")).toBeVisible();

    // Activity timeline shows the lead-created event.
    await expect(dialog.getByText("Activity")).toBeVisible();
    await expect(dialog.getByText("Lead created")).toBeVisible();
  });
});
