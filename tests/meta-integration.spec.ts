import { test, expect } from "@playwright/test";

// Reuses the project's seeded admin session (same fixture every other
// settings/integrations spec uses, e.g. integrations.spec.ts). Meta is a
// per-user integration now; this session's user must NOT have Meta connected
// so the card renders the connect form (the seeded e2e admin never connects).
test.use({ storageState: "playwright/.auth/user.json" });

test.describe("Meta integration", () => {
  test("card shows, validates connect, and offers CSV export", async ({
    page,
  }) => {
    await page.goto("/settings/integrations");

    // The card title text also appears in the helper copy, so pin the card via
    // its data-integration attribute (mirrors integrations.spec.ts).
    const card = page.locator(
      '[data-integration="Meta Ads (Facebook / Instagram)"]',
    );
    await expect(card).toBeVisible();
    await expect(
      card.getByText("Meta Ads (Facebook / Instagram)"),
    ).toBeVisible();

    // The acknowledgment label is always rendered while disconnected.
    await expect(card.getByText(/right to use these contacts/i)).toBeVisible();

    // Connecting with empty fields + the acknowledgment unchecked surfaces a
    // validation error (toast).
    await card.getByRole("button", { name: "Connect Meta" }).click();
    await expect(
      page.getByText("Please confirm you have the right to use this data."),
    ).toBeVisible();

    // The CSV export link is present.
    await expect(card.getByRole("link", { name: "Export CSV" })).toBeVisible();
  });
});
