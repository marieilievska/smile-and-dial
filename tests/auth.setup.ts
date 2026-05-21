import { test as setup } from "@playwright/test";

import { adminUser, memberUser, signIn } from "./helpers";

// Log in once per role and persist the sessions so authenticated specs can
// reuse them instead of signing in repeatedly (Supabase rate-limits sign-in).

setup("authenticate as admin", async ({ page }) => {
  await signIn(page, adminUser);
  await page.context().storageState({ path: "playwright/.auth/user.json" });
});

setup("authenticate as member", async ({ page }) => {
  await signIn(page, memberUser);
  await page.context().storageState({ path: "playwright/.auth/member.json" });
});
