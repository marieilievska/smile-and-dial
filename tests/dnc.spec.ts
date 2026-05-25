import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.use({ storageState: "playwright/.auth/user.json" });

test.describe.configure({ mode: "serial" });

test.describe("Do not call", () => {
  const stamp = Date.now();
  const tail = String(stamp).slice(-6);
  const phoneA = `+1888${tail}01`;
  const phoneB = `+1888${tail}02`;

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
});
