import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.use({ storageState: "playwright/.auth/user.json" });
test.describe.configure({ mode: "serial" });

test.describe("Agent template builder", () => {
  const stamp = Date.now();
  const agentName = `E2E Agent ${stamp}`;
  let admin: SupabaseClient;

  test.beforeAll(async () => {
    admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    await admin.from("agents").delete().like("name", "E2E Agent %");
  });

  test.afterAll(async () => {
    await admin.from("agents").delete().like("name", "E2E Agent %");
  });

  test("gallery → webinar template → edit script → save", async ({ page }) => {
    await page.goto("/settings/agents/new");

    // Gallery front door.
    await expect(
      page.getByRole("heading", { name: "Build agent" }),
    ).toBeVisible();
    await page.getByRole("link", { name: /Webinar invite/ }).click();
    await expect(page).toHaveURL(/\/new\/webinar$/);

    // The webinar script is pre-filled; the live preview shows the opening.
    await expect(page.getByTestId("preview-opening")).toContainText("Jamie");

    // Fill the name and change the schedule (the anti-landmine field).
    await page.getByLabel("Agent name").fill(agentName);
    await page
      .getByLabel("Event schedule", { exact: true })
      .fill("Every weekday at 3 PM Eastern");

    await page.getByRole("button", { name: "Save agent" }).click();
    await expect(page).toHaveURL(/\/settings\/agents$/);

    // DB shape: template snapshot + assembled prompt with the schedule injected ONCE.
    const { data: agent } = await admin
      .from("agents")
      .select(
        "name, template_key, instructions, key_details, system_prompt, elevenlabs_agent_id",
      )
      .eq("name", agentName)
      .single();
    expect(agent?.template_key).toBe("webinar");
    expect(agent?.instructions).toContain("exactly ONE question");
    expect(agent?.system_prompt).toContain("Every weekday at 3 PM Eastern");
    expect(agent?.elevenlabs_agent_id).toMatch(/^agent_mock_/);
    const details = agent?.key_details as { id: string; value: string }[];
    expect(details.find((d) => d.id === "event_schedule")?.value).toBe(
      "Every weekday at 3 PM Eastern",
    );
  });

  test("save is blocked until the name is filled", async ({ page }) => {
    await page.goto("/settings/agents/new/webinar");
    // Name starts empty → Save disabled.
    await expect(
      page.getByRole("button", { name: "Save agent" }),
    ).toBeDisabled();
    await page.getByLabel("Agent name").fill(`E2E Agent block ${Date.now()}`);
    await expect(
      page.getByRole("button", { name: "Save agent" }),
    ).toBeEnabled();
  });

  test("the old wizard still lives behind Advanced", async ({ page }) => {
    await page.goto("/settings/agents/new");
    await page
      .getByRole("link", { name: /Advanced — build from scratch/ })
      .click();
    await expect(page).toHaveURL(/\/new\/scratch$/);
    await expect(
      page.getByRole("heading", { name: "Build agent" }),
    ).toBeVisible();
    await expect(page.getByLabel("Name", { exact: true })).toBeVisible();
  });
});
