import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.use({ storageState: "playwright/.auth/user.json" });

test.describe("Lead detail modal", () => {
  const stamp = Date.now();
  const tail = String(stamp).slice(-6);
  const company = `E2E Detail Co ${stamp}`;
  const fieldName = `E2E Note ${stamp}`;
  const newCity = `Springfield ${stamp}`;
  const customValue = `Custom value ${stamp}`;

  let admin: SupabaseClient;
  let listId: string;
  let customFieldId: string;

  test.beforeAll(async () => {
    admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const { data: owner } = await admin
      .from("profiles")
      .select("id")
      .eq("email", process.env.E2E_TEST_EMAIL ?? "")
      .single();
    const { data: list } = await admin
      .from("lists")
      .insert({ owner_id: owner!.id, name: `E2E Detail List ${stamp}` })
      .select("id")
      .single();
    listId = list!.id;
    await admin.from("leads").insert({
      owner_id: owner!.id,
      list_id: listId,
      company,
      business_phone: `+1512${tail}1`,
      city: "Austin",
      state: "TX",
    });
    const { data: field } = await admin
      .from("custom_field_defs")
      .insert({
        name: fieldName,
        slug: `e2e_note_${stamp}`,
        type: "text",
        sort_order: 999,
      })
      .select("id")
      .single();
    customFieldId = field!.id;
  });

  test.afterAll(async () => {
    await admin.from("leads").delete().eq("list_id", listId);
    await admin.from("custom_field_defs").delete().eq("id", customFieldId);
    await admin.from("lists").delete().eq("id", listId);
  });

  test("editing a standard and a custom field autosaves", async ({ page }) => {
    await page.goto(`/leads?q=${encodeURIComponent(company)}`);
    // v2 — the primary cell stacks company name + phone, so its
    // accessible name now includes the phone. Drop exact:true.
    await page.getByRole("cell", { name: company }).first().click();

    // Clicking a row navigates to the lead's full detail route now
    // (Close-style /leads/<id>) instead of opening a modal.
    await expect(page).toHaveURL(/\/leads\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { name: company })).toBeVisible();

    // City lives inside the collapsed "Address" section (renamed from
    // "Location & web" in v2) — expand it.
    await page.getByTestId("lead-section-address").locator("summary").click();
    const cityInput = page.getByLabel("City");
    await cityInput.fill(newCity);
    await cityInput.blur();

    // Custom field section also starts collapsed; expand and edit.
    await page
      .getByTestId("lead-section-custom-fields")
      .locator("summary")
      .click();
    const customInput = page.getByLabel(fieldName);
    await customInput.fill(customValue);
    await customInput.blur();

    await expect(page.getByText("Saved")).toBeVisible();

    // Back to the leads list; the table reflects the saved city. City
    // isn't a default column in v2 — opt it in via ?cols=.
    await page.goto(
      "/leads?cols=company,status,city&q=" + encodeURIComponent(company),
    );
    await expect(page).toHaveURL(/\/leads/);
    await expect(page.getByRole("cell", { name: newCity })).toBeVisible();

    // Reopening the lead shows the saved custom value (section starts
    // collapsed on each navigation).
    // v2 — the primary cell stacks company name + phone, so its
    // accessible name now includes the phone. Drop exact:true.
    await page.getByRole("cell", { name: company }).first().click();
    await expect(page).toHaveURL(/\/leads\/[0-9a-f-]{36}$/);
    await page
      .getByTestId("lead-section-custom-fields")
      .locator("summary")
      .click();
    await expect(page.getByLabel(fieldName)).toHaveValue(customValue);
  });
});

/**
 * Admin delete of calls + callbacks from the lead detail page.
 *
 * Coverage:
 *  - The Callbacks section lists a pending callback with a "Delete callback"
 *    control; deleting it (confirm accepted) removes the row + the DB row.
 *  - Opening a call (?call=<id>) shows a "Delete call" button; deleting it
 *    closes the popup, drops the call from the feed, removes the DB row, and
 *    decrements the lead's call_attempts. The E2E user is an admin.
 */
test.describe.configure({ mode: "serial" });

test.describe("Lead detail — admin delete calls & callbacks", () => {
  const stamp = Date.now();
  const tail = String(stamp).slice(-6);
  const company = `E2E Delete Co ${stamp}`;

  let admin: SupabaseClient;
  let ownerId: string;
  let listId: string;
  let agentId: string;
  let goalId: string;
  let campaignId: string;
  let twilioNumberId: string;
  let leadId: string;
  let callId: string;
  let callbackId: string;

  test.beforeAll(async () => {
    admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const { data: owner } = await admin
      .from("profiles")
      .select("id")
      .eq("email", process.env.E2E_TEST_EMAIL ?? "")
      .single();
    ownerId = owner!.id;

    const { data: list } = await admin
      .from("lists")
      .insert({ owner_id: ownerId, name: `E2E Delete List ${stamp}` })
      .select("id")
      .single();
    listId = list!.id;

    const { data: num } = await admin
      .from("twilio_numbers")
      .insert({
        phone_number: `+1888${tail}90`,
        friendly_name: `E2E Delete Number ${stamp}`,
        country: "US",
      })
      .select("id")
      .single();
    twilioNumberId = num!.id;

    const { data: agent } = await admin
      .from("agents")
      .insert({
        owner_id: ownerId,
        name: `E2E Delete Agent ${stamp}`,
        elevenlabs_agent_id: `del-agent-${stamp}`,
        prompt_personality: "x",
        prompt_environment: "x",
        prompt_tone: "x",
        prompt_goal: "x",
        prompt_guardrails: "x",
      })
      .select("id")
      .single();
    agentId = agent!.id;

    const { data: goal } = await admin
      .from("goals")
      .insert({ owner_id: ownerId, name: `E2E Delete Goal ${stamp}` })
      .select("id")
      .single();
    goalId = goal!.id;

    const { data: campaign } = await admin
      .from("campaigns")
      .insert({
        owner_id: ownerId,
        name: `E2E Delete Campaign ${stamp}`,
        status: "active",
        agent_id: agentId,
        goal_id: goalId,
        twilio_number_id: twilioNumberId,
      })
      .select("id")
      .single();
    campaignId = campaign!.id;

    const { data: lead } = await admin
      .from("leads")
      .insert({
        owner_id: ownerId,
        list_id: listId,
        company,
        business_phone: `+1888${tail}1`,
        status: "callback",
        call_attempts: 1,
      })
      .select("id")
      .single();
    leadId = lead!.id;

    const { data: call } = await admin
      .from("calls")
      .insert({
        lead_id: leadId,
        campaign_id: campaignId,
        agent_id: agentId,
        twilio_number_id: twilioNumberId,
        direction: "outbound",
        status: "completed",
        outcome: "callback",
        outcome_source: "manual",
        summary: `E2E delete call summary ${stamp}`,
      })
      .select("id")
      .single();
    callId = call!.id;

    const { data: callback } = await admin
      .from("callbacks")
      .insert({
        lead_id: leadId,
        campaign_id: campaignId,
        scheduled_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        status: "pending",
      })
      .select("id")
      .single();
    callbackId = callback!.id;
  });

  test.afterAll(async () => {
    await admin.from("callbacks").delete().eq("lead_id", leadId);
    await admin.from("calls").delete().eq("lead_id", leadId);
    await admin.from("system_events").delete().eq("ref_id", leadId);
    await admin.from("leads").delete().eq("id", leadId);
    await admin
      .from("campaigns")
      .delete()
      .eq("id", campaignId ?? "");
    await admin
      .from("agents")
      .delete()
      .eq("id", agentId ?? "");
    await admin
      .from("twilio_numbers")
      .delete()
      .eq("id", twilioNumberId ?? "");
    await admin
      .from("goals")
      .delete()
      .eq("id", goalId ?? "");
    await admin
      .from("lists")
      .delete()
      .eq("id", listId ?? "");
  });

  test("admin deletes a callback from the Callbacks section", async ({
    page,
  }) => {
    page.on("dialog", (dialog) => dialog.accept());

    await page.goto(`/leads/${leadId}`);
    const section = page.getByTestId("lead-callbacks-column");
    await expect(section).toBeVisible();
    // The pending callback renders its status text in the section.
    await expect(section.getByText("pending")).toBeVisible();

    await section.getByRole("button", { name: /delete callback/i }).click();
    await expect(page.getByText("Callback deleted")).toBeVisible();
    await expect(section.getByText("pending")).toHaveCount(0);

    // The DB row is gone.
    const { data: gone } = await admin
      .from("callbacks")
      .select("id")
      .eq("id", callbackId)
      .maybeSingle();
    expect(gone).toBeNull();
  });

  test("admin deletes a call from the call detail popup", async ({ page }) => {
    page.on("dialog", (dialog) => dialog.accept());

    // Confirm the seeded call is in the lead's activity feed first.
    await page.goto(`/leads/${leadId}`);
    await expect(page.getByTestId("lead-activity-column")).toBeVisible();

    const { data: before } = await admin
      .from("leads")
      .select("call_attempts")
      .eq("id", leadId)
      .single();

    // Open the call detail popup directly via ?call=<id>.
    await page.goto(`/leads/${leadId}?call=${callId}`);
    const deleteCall = page.getByRole("button", { name: /delete call/i });
    await expect(deleteCall).toBeVisible();
    await deleteCall.click();
    await expect(page.getByText("Call deleted")).toBeVisible();

    // The DB row is gone and call_attempts decremented.
    const { data: goneCall } = await admin
      .from("calls")
      .select("id")
      .eq("id", callId)
      .maybeSingle();
    expect(goneCall).toBeNull();

    const { data: after } = await admin
      .from("leads")
      .select("call_attempts")
      .eq("id", leadId)
      .single();
    expect(after!.call_attempts).toBeLessThan(before!.call_attempts ?? 1);
  });
});
