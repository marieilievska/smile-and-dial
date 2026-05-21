import { expect, type Page } from "@playwright/test";

const email = process.env.E2E_TEST_EMAIL ?? "";
const password = process.env.E2E_TEST_PASSWORD ?? "";

/** Sign in through the UI with the E2E test account. */
export async function signIn(page: Page) {
  expect(email, "E2E_TEST_EMAIL must be set").not.toBe("");
  expect(password, "E2E_TEST_PASSWORD must be set").not.toBe("");

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/leads$/);
}
