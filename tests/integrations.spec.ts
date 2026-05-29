import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

test.use({ storageState: "playwright/.auth/user.json" });

test.describe("integrations", () => {
  // The ElevenLabs voice-id allowlist lives in a shared single-row
  // table; reset it afterwards so the test leaves no trace. Round L1 —
  // the ElevenLabs API key is no longer in this table (it lives in
  // server env now), so the reset only touches the voice IDs.
  test.afterAll(async () => {
    const admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    await admin
      .from("app_settings")
      .update({ elevenlabs_voice_ids: null })
      .eq("id", 1);
  });

  test("an admin can save ElevenLabs settings", async ({ page }) => {
    const stamp = Date.now();
    const voiceIds = `voice_e2e_${stamp}`;

    await page.goto("/settings/integrations");
    // Round L1 — the helper text now mentions ELEVENLABS_API_KEY so
    // "ElevenLabs" matches in multiple places; pin the assertion to
    // the card title via the data-integration attribute.
    await expect(page.locator('[data-integration="ElevenLabs"]')).toBeVisible();

    // The form no longer has an API key field — only the voice-id
    // allowlist. The ElevenLabs API key lives in ELEVENLABS_API_KEY
    // on the server.
    await page.getByLabel("Allowed voice IDs").fill(voiceIds);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("ElevenLabs settings saved.")).toBeVisible();

    // The voice IDs persist across a reload, and there's no API key
    // field to assert about anymore.
    await page.reload();
    await expect(page.getByLabel("Allowed voice IDs")).toHaveValue(voiceIds);
    await expect(page.getByLabel("API key")).toHaveCount(0);
  });
});
