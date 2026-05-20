import { test, expect } from "@playwright/test";

test("homepage renders the Smile & Dial wordmark", async ({ page }) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", { level: 1, name: "Smile & Dial" }),
  ).toBeVisible();

  await expect(
    page.getByText("AI calling platform for Referrizer."),
  ).toBeVisible();
});

test("design tokens drive both light and dark themes", async ({ page }) => {
  await page.goto("/");

  // Light theme — surface is #FAF9F7 (BUILD_PLAN.md Section 19).
  const lightBackground = await page.evaluate(
    () => getComputedStyle(document.body).backgroundColor,
  );
  expect(lightBackground).toBe("rgb(250, 249, 247)");

  // Dark theme — surface is #13151B (BUILD_PLAN.md Section 19).
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  const darkBackground = await page.evaluate(
    () => getComputedStyle(document.body).backgroundColor,
  );
  expect(darkBackground).toBe("rgb(19, 21, 27)");
});
