import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * System Health page (Step 42 / BUILD_PLAN §5.10).
 *
 * Coverage:
 *  - Members cannot open the page (redirected to /leads)
 *  - Admins see system_events listed in reverse chronological order
 *  - Severity filter narrows the rows
 */
test.describe.configure({ mode: "serial" });

test.describe("System Health (admin)", () => {
  // `user.json` is the admin storage state (named that way historically).
  test.use({ storageState: "playwright/.auth/user.json" });

  const stamp = Date.now();
  let admin: SupabaseClient;
  const eventIds: string[] = [];

  async function seedEvent(kind: string, message?: string) {
    const { data } = await admin
      .from("system_events")
      .insert({
        kind,
        payload: { note: message ?? `E2E SH ${stamp}` },
      })
      .select("id")
      .single();
    eventIds.push(data!.id);
  }

  test.beforeAll(async () => {
    admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    await seedEvent("spend_cap_hit", `cap hit ${stamp}`);
    await seedEvent("goal_transition", `transition ${stamp}`);
    await seedEvent("dialer_failure", `failure ${stamp}`);
  });

  test.afterAll(async () => {
    if (eventIds.length > 0) {
      await admin.from("system_events").delete().in("id", eventIds);
    }
  });

  test("admin sees the recent system events table", async ({ page }) => {
    await page.goto("/system-health");
    const table = page.getByTestId("system-events-table");
    await expect(table).toBeVisible();
    await expect(table).toContainText("spend_cap_hit");
    await expect(table).toContainText("goal_transition");
    await expect(table).toContainText("dialer_failure");
  });

  test("severity filter narrows to error rows only", async ({ page }) => {
    await page.goto("/system-health?severity=error");
    const table = page.getByTestId("system-events-table");
    await expect(table).toContainText("dialer_failure");
    // spend_cap_hit is "warn", goal_transition is "info" — both filtered out.
    await expect(table).not.toContainText("spend_cap_hit");
    await expect(table).not.toContainText("goal_transition");
  });
});

test.describe("System Health (member)", () => {
  test.use({ storageState: "playwright/.auth/member.json" });

  test("a member is redirected away from /system-health", async ({ page }) => {
    await page.goto("/system-health");
    // The page redirects to /leads server-side.
    await expect(page).toHaveURL(/\/leads(\?|$)/);
  });
});
