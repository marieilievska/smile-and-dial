import { test, expect } from "@playwright/test";

test.use({ storageState: "playwright/.auth/user.json" });

test.describe("integrations", () => {
  // Close, Calendly and Meta are all PER-USER integrations now — each account
  // connects its own. ElevenLabs/Twilio/OpenAI are a single shared account
  // configured in the server env, so they no longer appear on this page (the
  // old ElevenLabs voice-id allowlist was retired in favour of a fixed
  // code-level voice roster).
  test("shows the three per-user integration cards and no ElevenLabs card", async ({
    page,
  }) => {
    await page.goto("/settings/integrations");

    await expect(
      page.locator('[data-integration="Meta Ads (Facebook / Instagram)"]'),
    ).toBeVisible();
    await expect(page.locator('[data-integration="Close"]')).toBeVisible();
    await expect(page.locator('[data-integration="Calendly"]')).toBeVisible();

    // The ElevenLabs card and its voice-id allowlist are gone.
    await expect(page.locator('[data-integration="ElevenLabs"]')).toHaveCount(
      0,
    );
    await expect(page.getByLabel("Allowed voice IDs")).toHaveCount(0);
  });
});
