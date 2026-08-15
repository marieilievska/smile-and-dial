import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.use({ storageState: "playwright/.auth/user.json" });
test.describe.configure({ mode: "serial" });

test.describe("Save as template", () => {
  const stamp = Date.now();
  const agentName = `E2E Tmpl Agent ${stamp}`;
  const templateName = `E2E Template ${stamp}`;
  let admin: SupabaseClient;
  let agentId: string;

  test.beforeAll(async () => {
    admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    await admin.from("agent_templates").delete().like("name", "E2E Template %");
    await admin.from("agents").delete().like("name", "E2E Tmpl Agent %");
    const { data: owner } = await admin
      .from("profiles")
      .select("id")
      .eq("email", process.env.E2E_TEST_EMAIL ?? "")
      .single();
    const { data: seed } = await admin
      .from("agents")
      .insert({
        owner_id: owner!.id,
        name: agentName,
        system_prompt: "Say hi and book a demo on 2026-09-24.",
      })
      .select("id")
      .single();
    agentId = seed!.id;
  });

  test.afterAll(async () => {
    await admin.from("agent_templates").delete().like("name", "E2E Template %");
    await admin.from("agents").delete().like("name", "E2E Tmpl Agent %");
  });

  test("admin saves an agent as a shared template that appears in the gallery", async ({
    page,
  }) => {
    await page.goto(`/settings/agents/templates/new?from=${agentId}`);
    // Builder is in template mode: a Template name + editable Instructions.
    await page.getByLabel("Template name").fill(templateName);
    await page.getByLabel("Description").fill("E2E win-back");
    // Purpose/Goal are required by validateScript.
    await page.getByLabel("Purpose").fill("Win back lapsed customers.");
    await page.getByLabel("Goal — what counts as success").fill("Book a call.");
    await page.getByRole("button", { name: /Save as template/ }).click();

    await expect(page).toHaveURL(/\/settings\/agents\/new$/);
    await expect(page.getByText(templateName)).toBeVisible();

    const { data: tmpl } = await admin
      .from("agent_templates")
      .select("name, instructions, script")
      .eq("name", templateName)
      .single();
    expect(tmpl?.instructions).toContain("exactly ONE question");
    expect((tmpl?.script as { purpose: string }).purpose).toBe(
      "Win back lapsed customers.",
    );
  });
});
