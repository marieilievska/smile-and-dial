import { expect, type Page } from "@playwright/test";

export type TestUser = { email: string; password: string };

export const adminUser: TestUser = {
  email: process.env.E2E_TEST_EMAIL ?? "",
  password: process.env.E2E_TEST_PASSWORD ?? "",
};

export const memberUser: TestUser = {
  email: process.env.E2E_MEMBER_EMAIL ?? "",
  password: process.env.E2E_MEMBER_PASSWORD ?? "",
};

/** Sign in through the UI. Defaults to the admin E2E account. */
export async function signIn(page: Page, user: TestUser = adminUser) {
  expect(user.email, "test user email must be set").not.toBe("");
  expect(user.password, "test user password must be set").not.toBe("");

  await page.goto("/login");
  await page.getByLabel("Email").fill(user.email);
  // Exact match — the password input shares its short accessible name
  // with the show/hide eye toggle ("Show password" / "Hide password").
  await page.getByLabel("Password", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  // Post-login lands on /today (the dashboard) by default.
  await expect(page).toHaveURL(/\/today$/);
}
