import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

// These specs exercise the unauthenticated invite / reset link flow.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe("set-password flow", () => {
  test("a user can set their password from a confirm link", async ({
    page,
  }) => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
    expect(url, "NEXT_PUBLIC_SUPABASE_URL must be set").not.toBe("");
    expect(serviceKey, "SUPABASE_SERVICE_ROLE_KEY must be set").not.toBe("");

    const admin = createClient(url, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // A throwaway user, created and deleted within this test.
    const email = `e2e-setpw-${Date.now()}@smileanddial.com`;
    const { data: created, error: createError } =
      await admin.auth.admin.createUser({
        email,
        email_confirm: true,
        user_metadata: { role: "member", full_name: "E2E Set-Password" },
      });
    expect(createError).toBeNull();
    const userId = created.user!.id;

    try {
      const { data: link, error: linkError } =
        await admin.auth.admin.generateLink({ type: "recovery", email });
      expect(linkError).toBeNull();
      const tokenHash = link.properties!.hashed_token;

      await page.goto(
        `/auth/confirm?token_hash=${tokenHash}&type=recovery&next=/auth/set-password`,
      );
      await expect(page).toHaveURL(/\/auth\/set-password$/);

      await page.getByLabel("New password").fill("e2e-new-password-123");
      await page.getByLabel("Confirm password").fill("e2e-new-password-123");
      await page.getByRole("button", { name: "Set password" }).click();

      await expect(page).toHaveURL(/\/leads$/);
    } finally {
      await admin.auth.admin.deleteUser(userId);
    }
  });

  test("an invalid confirm link shows the error page", async ({ page }) => {
    await page.goto(
      "/auth/confirm?token_hash=invalid-token&type=recovery&next=/auth/set-password",
    );
    await expect(page).toHaveURL(/\/auth\/auth-error$/);
  });
});
