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

  test("the page shows AI summary, pipeline context, and activity", async ({
    page,
  }) => {
    await page.goto(`/leads?q=${encodeURIComponent(company)}`);
    await page.getByRole("cell", { name: company, exact: true }).click();

    // Now navigates to the full /leads/<id> route (Close-style).
    await expect(page).toHaveURL(/\/leads\/[0-9a-f-]{36}$/);

    // AI summary block is in the center column.
    await expect(page.getByTestId("ai-summary-block")).toBeVisible();
    await expect(page.getByTestId("ai-summary-block")).toContainText(summary);

    // At-a-glance strip shows the list and the pipeline status badge
    // ("Ready to call" — humanized "ready_to_call").
    await expect(page.getByText(listName)).toBeVisible();
    await expect(page.getByText("Ready to call").first()).toBeVisible();

    // Activity column on the right is always visible — with no seeded
    // calls/emails/events, it shows the empty-state copy.
    const activityColumn = page.getByTestId("lead-activity-column");
    await expect(activityColumn).toBeVisible();
    await expect(activityColumn).toContainText("No activity yet");
  });
});
