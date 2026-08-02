import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * First-run onboarding contract (Part B): the one-time welcome primer and the
 * per-user "Getting started" checklist on Today.
 *
 * NOTE: runs against the deployed environment (Playwright is the contract
 * here, not a local/CI gate). Resets the member's onboarding flags via the
 * service role so both surfaces render deterministically.
 */
test.describe.configure({ mode: "serial" });

test.describe("first-run onboarding", () => {
  test.use({ storageState: "playwright/.auth/member.json" });

  const memberEmail = process.env.E2E_MEMBER_EMAIL ?? "";
  let admin: SupabaseClient;

  test.beforeAll(() => {
    admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
  });

  test.beforeEach(async () => {
    // Clear the flags so the welcome + checklist show for the member.
    await admin
      .from("profiles")
      .update({ welcome_seen_at: null, onboarding_dismissed_at: null })
      .eq("email", memberEmail);
  });

  test("the welcome primer greets a new member and points at Import leads", async ({
    page,
  }) => {
    await page.goto("/today");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/Welcome to Smile and Dial/)).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Import leads" }),
    ).toBeVisible();
    // The four building blocks are named.
    await expect(dialog.getByText("Leads", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Campaign", { exact: true })).toBeVisible();
  });

  test("after dismissing the welcome, the onboarding surface shows", async ({
    page,
  }) => {
    await page.goto("/today");
    await page.getByRole("button", { name: "Explore on my own" }).click();
    // Either the checklist (incomplete) or the success state (already live).
    const onboarding = page.locator(
      '[data-testid="onboarding-checklist"], [data-testid="onboarding-success"]',
    );
    await expect(onboarding.first()).toBeVisible();
  });

  test("Hide for now removes the checklist", async ({ page }) => {
    await page.goto("/today");
    await page.getByRole("button", { name: "Explore on my own" }).click();
    const checklist = page.getByTestId("onboarding-checklist");
    // Only meaningful when the checklist (not the success state) is showing.
    if (await checklist.isVisible()) {
      await page.getByRole("button", { name: "Hide for now" }).click();
      await expect(checklist).toBeHidden();
    }
  });
});
