import { test as setup } from "@playwright/test";

import { signIn } from "./helpers";

// Log in once and persist the session so authenticated specs can reuse it
// instead of signing in repeatedly (which trips Supabase auth rate limits).
const authFile = "playwright/.auth/user.json";

setup("authenticate", async ({ page }) => {
  await signIn(page);
  await page.context().storageState({ path: authFile });
});
