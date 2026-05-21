import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

test.use({ storageState: "playwright/.auth/user.json" });

test.describe("integrations", () => {
  // The ElevenLabs settings live in a shared single-row table; reset them
  // afterwards so the test leaves no trace.
  test.afterAll(async () => {
    const admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    await admin
      .from("app_settings")
      .update({ elevenlabs_api_key: null, elevenlabs_voice_ids: null })
      .eq("id", 1);
  });

  test("an admin can save ElevenLabs settings", async ({ page }) => {
    const stamp = Date.now();
    const voiceIds = `voice_e2e_${stamp}`;

    await page.goto("/settings/integrations");
    await expect(page.getByText("ElevenLabs")).toBeVisible();

    await page.getByLabel("Allowed voice IDs").fill(voiceIds);
    await page.getByLabel("API key").fill(`sk_e2e_${stamp}`);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("ElevenLabs settings saved.")).toBeVisible();

    // The voice IDs persist, and the API key is now stored (not echoed back).
    await page.reload();
    await expect(page.getByLabel("Allowed voice IDs")).toHaveValue(voiceIds);
    await expect(page.getByLabel("API key")).toHaveAttribute(
      "placeholder",
      /A key is saved/,
    );
  });
});
