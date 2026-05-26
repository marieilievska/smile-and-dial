import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.use({ storageState: "playwright/.auth/user.json" });

test.describe.configure({ mode: "serial" });

/**
 * Calls page (Step 27a). Read-only table with search, sortable headers,
 * pagination, and the basic filter row (campaign / direction / status /
 * outcome / date range). Detail modal + column picker + saved views land
 * in Steps 27b / 28.
 */
test.describe("Calls page", () => {
  const stamp = Date.now();
  const tail = String(stamp).slice(-6);

  let admin: SupabaseClient;
  let ownerId: string;
  let listId: string;
  let twilioNumberId: string;
  let campaignId: string;
  let otherCampaignId: string;
  let agentId: string;
  let goalId: string;
  const callIds: string[] = [];
  const leadIds: string[] = [];

  async function seedLead(label: string, suffix: string): Promise<string> {
    const { data } = await admin
      .from("leads")
      .insert({
        owner_id: ownerId,
        list_id: listId,
        company: `E2E Calls ${label} ${stamp}`,
        business_phone: `+1444${tail}${suffix}`,
      })
      .select("id")
      .single();
    leadIds.push(data!.id);
    return data!.id;
  }

  async function seedCall(opts: {
    leadId: string;
    campaignId: string;
    direction?: "outbound" | "inbound";
    status?: string;
    outcome?: string | null;
    durationSeconds?: number;
    startedAt?: Date;
    cost?: number;
  }): Promise<string> {
    const { data } = await admin
      .from("calls")
      .insert({
        lead_id: opts.leadId,
        campaign_id: opts.campaignId,
        agent_id: agentId,
        twilio_number_id: twilioNumberId,
        direction: opts.direction ?? "outbound",
        status: opts.status ?? "completed",
        outcome: opts.outcome ?? null,
        // Keep goal_met in sync with the outcome — same invariant the
        // post-call webhook maintains in real life.
        goal_met: opts.outcome === "goal_met",
        duration_seconds: opts.durationSeconds ?? 45,
        talk_time_seconds: 30,
        started_at: (opts.startedAt ?? new Date()).toISOString(),
        ended_at: new Date(
          (opts.startedAt ?? new Date()).getTime() +
            (opts.durationSeconds ?? 45) * 1000,
        ).toISOString(),
        cost_breakdown: { total: opts.cost ?? 0.07 },
      })
      .select("id")
      .single();
    callIds.push(data!.id);
    return data!.id;
  }

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
      .insert({ owner_id: ownerId, name: `E2E Calls List ${stamp}` })
      .select("id")
      .single();
    listId = list!.id;

    const { data: num } = await admin
      .from("twilio_numbers")
      .insert({
        phone_number: `+1444${tail}99`,
        friendly_name: `E2E Calls Number ${stamp}`,
        country: "US",
      })
      .select("id")
      .single();
    twilioNumberId = num!.id;

    const { data: agent } = await admin
      .from("agents")
      .insert({
        owner_id: ownerId,
        name: `E2E Calls Agent ${stamp}`,
        elevenlabs_agent_id: `calls-agent-${stamp}`,
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
      .insert({ owner_id: ownerId, name: `E2E Calls Goal ${stamp}` })
      .select("id")
      .single();
    goalId = goal!.id;

    const { data: cMain } = await admin
      .from("campaigns")
      .insert({
        owner_id: ownerId,
        name: `E2E Calls Main Campaign ${stamp}`,
        status: "active",
        agent_id: agentId,
        goal_id: goalId,
      })
      .select("id")
      .single();
    campaignId = cMain!.id;

    const { data: cOther } = await admin
      .from("campaigns")
      .insert({
        owner_id: ownerId,
        name: `E2E Calls Other Campaign ${stamp}`,
        status: "active",
        agent_id: agentId,
        goal_id: goalId,
      })
      .select("id")
      .single();
    otherCampaignId = cOther!.id;

    // Seed three calls — different outcomes, campaigns, directions — so the
    // filters have something to narrow against.
    const lead1 = await seedLead("Alpha", "10");
    const lead2 = await seedLead("Beta", "11");
    const lead3 = await seedLead("Gamma", "12");
    await seedCall({
      leadId: lead1,
      campaignId,
      outcome: "voicemail",
      durationSeconds: 18,
    });
    await seedCall({
      leadId: lead2,
      campaignId: otherCampaignId,
      outcome: "goal_met",
      durationSeconds: 120,
    });
    await seedCall({
      leadId: lead3,
      campaignId,
      direction: "inbound",
      outcome: "callback",
      durationSeconds: 60,
    });
  });

  test.afterAll(async () => {
    // Clean up any saved views the saved-view test created.
    await admin
      .from("saved_views")
      .delete()
      .eq("page", "calls")
      .like("name", `E2E Saved ${stamp}%`);
    // Clean up callbacks + system_events created by the override + schedule
    // callback tests.
    if (callIds.length > 0) {
      await admin.from("callbacks").delete().in("originating_call_id", callIds);
      await admin
        .from("system_events")
        .delete()
        .eq("ref_table", "calls")
        .in("ref_id", callIds);
      await admin.from("calls").delete().in("id", callIds);
    }
    if (leadIds.length > 0) {
      await admin.from("leads").delete().in("id", leadIds);
    }
    await admin
      .from("campaigns")
      .delete()
      .in("id", [campaignId, otherCampaignId].filter(Boolean) as string[]);
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

  test("the page lists seeded calls with their lead, campaign, and outcome", async ({
    page,
  }) => {
    await page.goto(
      `/calls?q=${encodeURIComponent(`E2E Calls Alpha ${stamp}`)}`,
    );
    // The Alpha row shows up; the others don't (filtered by search).
    await expect(
      page.getByRole("cell", { name: `E2E Calls Alpha ${stamp}` }),
    ).toBeVisible();
    await expect(
      page.getByRole("cell", { name: `E2E Calls Beta ${stamp}` }),
    ).toHaveCount(0);
  });

  test("the outcome filter narrows to a single row", async ({ page }) => {
    await page.goto(`/calls?campaign=${campaignId}&outcome=callback`);
    // Of our 3 seeds, only Gamma's outcome=callback under the main campaign.
    const rows = page.locator("tbody tr");
    await expect(rows).toHaveCount(1);
    await expect(
      page.getByRole("cell", { name: `E2E Calls Gamma ${stamp}` }),
    ).toBeVisible();
  });

  test("the direction filter splits inbound vs outbound", async ({ page }) => {
    await page.goto(`/calls?campaign=${campaignId}&direction=inbound`);
    await expect(
      page.getByRole("cell", { name: `E2E Calls Gamma ${stamp}` }),
    ).toBeVisible();
    await expect(
      page.getByRole("cell", { name: `E2E Calls Alpha ${stamp}` }),
    ).toHaveCount(0);

    await page.goto(`/calls?campaign=${campaignId}&direction=outbound`);
    await expect(
      page.getByRole("cell", { name: `E2E Calls Alpha ${stamp}` }),
    ).toBeVisible();
    await expect(
      page.getByRole("cell", { name: `E2E Calls Gamma ${stamp}` }),
    ).toHaveCount(0);
  });

  test("sorting by duration ascending puts the shortest call first", async ({
    page,
  }) => {
    await page.goto(
      `/calls?campaign=${campaignId}&sort=duration_seconds&dir=asc`,
    );
    // Alpha is 18s (voicemail), Gamma is 60s (callback). Alpha first.
    const firstCompanyCell = page.locator("tbody tr td").nth(1);
    await expect(firstCompanyCell).toHaveText(`E2E Calls Alpha ${stamp}`);
  });

  test("an empty-state message renders when no calls match", async ({
    page,
  }) => {
    await page.goto("/calls?q=__no_such_company__");
    await expect(page.getByText("No calls yet")).toBeVisible();
  });

  test("the goal_met filter narrows to the goal-met call", async ({ page }) => {
    // Scope by stamp so prior test runs' goal_met calls don't drown us out.
    await page.goto(`/calls?goal_met=yes&q=${stamp}`);
    await expect(
      page.getByRole("cell", { name: `E2E Calls Beta ${stamp}` }),
    ).toBeVisible();
    await expect(
      page.getByRole("cell", { name: `E2E Calls Alpha ${stamp}` }),
    ).toHaveCount(0);
  });

  test("min/max duration narrows the rows", async ({ page }) => {
    await page.goto(`/calls?campaign=${campaignId}&min_dur=30&max_dur=90`);
    // Of our two main-campaign seeds (18s + 60s), only the 60s callback fits.
    await expect(
      page.getByRole("cell", { name: `E2E Calls Gamma ${stamp}` }),
    ).toBeVisible();
    await expect(
      page.getByRole("cell", { name: `E2E Calls Alpha ${stamp}` }),
    ).toHaveCount(0);
  });

  test("toggling a column off via the Columns popover hides its header", async ({
    page,
  }) => {
    await page.goto(
      `/calls?q=${encodeURIComponent(`E2E Calls Alpha ${stamp}`)}`,
    );
    // The "Cost" column is in the default set — visible.
    await expect(
      page.getByRole("columnheader", { name: "Cost" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Columns" }).click();
    await page.getByLabel("Cost").click();
    // Click outside to close the popover so subsequent assertions aren't
    // racing the dropdown animation.
    await page.keyboard.press("Escape");

    await expect(page.getByRole("columnheader", { name: "Cost" })).toHaveCount(
      0,
    );
    // The URL now reflects the column choice.
    await expect(page).toHaveURL(/cols=/);
  });

  test("admin can save the current view and apply it later", async ({
    page,
  }) => {
    const viewName = `E2E Saved ${stamp}`;
    // Land on a specific filter so the save has interesting params.
    await page.goto(`/calls?direction=inbound`);

    await page.getByRole("button", { name: "Views" }).click();
    await page.getByRole("button", { name: "Save current view" }).click();
    await page.getByLabel("View name").fill(viewName);
    await page.getByRole("button", { name: "Save view" }).click();
    await expect(page.getByText("View saved.")).toBeVisible();

    // Apply the view from a different starting URL. Hard-reload so we see
    // the freshly-revalidated server-rendered views list.
    await page.goto("/calls");
    await page.reload();
    await page.getByRole("button", { name: "Views" }).click();
    const viewButton = page.getByRole("button", {
      name: viewName,
      exact: true,
    });
    await expect(viewButton).toBeVisible({ timeout: 10_000 });
    await viewButton.click();
    await expect(page).toHaveURL(/direction=inbound/);

    // Clean up: delete the view from the popover.
    await page.getByRole("button", { name: "Views" }).click();
    await page.getByRole("button", { name: `Delete view ${viewName}` }).click();
    await expect(page.getByText("View deleted.")).toBeVisible();
  });

  test("clicking a row opens the call detail modal", async ({ page }) => {
    // Seed a richer call so the modal has summary + transcript to render.
    const detailLead = await admin
      .from("leads")
      .insert({
        owner_id: ownerId,
        list_id: listId,
        company: `E2E Calls Detail ${stamp}`,
        business_phone: `+1444${tail}19`,
      })
      .select("id")
      .single();
    const richCallId = (
      await admin
        .from("calls")
        .insert({
          lead_id: detailLead.data!.id,
          campaign_id: campaignId,
          agent_id: agentId,
          twilio_number_id: twilioNumberId,
          direction: "outbound",
          status: "completed",
          outcome: "callback",
          goal_met: false,
          duration_seconds: 92,
          talk_time_seconds: 71,
          started_at: new Date().toISOString(),
          ended_at: new Date(Date.now() + 92_000).toISOString(),
          summary: "Lead wants a callback next Tuesday at 2pm.",
          transcript_json: [
            { role: "agent", text: "Hi, this is Sara at Referrizer." },
            { role: "user", text: "Sure, call me back Tuesday at 2." },
          ],
          extracted_data: { disposition: "callback" },
          cost_breakdown: { total: 0.07 },
        })
        .select("id")
        .single()
    ).data!.id;
    leadIds.push(detailLead.data!.id);
    callIds.push(richCallId);

    await page.goto(
      `/calls?q=${encodeURIComponent(`E2E Calls Detail ${stamp}`)}`,
    );
    // Click the row.
    await page.getByRole("cell", { name: `E2E Calls Detail ${stamp}` }).click();
    // URL updates with ?call=…
    await expect(page).toHaveURL(/call=/);
    // The summary text renders inside the dialog.
    await expect(
      page.getByText("Lead wants a callback next Tuesday at 2pm."),
    ).toBeVisible();
    // The transcript turn text is there too.
    await expect(
      page.getByText("Hi, this is Sara at Referrizer."),
    ).toBeVisible();
    // And the "Open lead" button links to the right lead detail.
    await expect(page.getByRole("link", { name: "Open lead" })).toHaveAttribute(
      "href",
      `/leads?lead=${detailLead.data!.id}`,
    );

    // Close the sheet — the URL drops the call param.
    await page.keyboard.press("Escape");
    await expect(page).not.toHaveURL(/call=/);
  });

  test("overriding the outcome updates the call and writes a system_events row", async ({
    page,
  }) => {
    // Seed a call we can override.
    const overrideLead = await admin
      .from("leads")
      .insert({
        owner_id: ownerId,
        list_id: listId,
        company: `E2E Calls Override ${stamp}`,
        business_phone: `+1444${tail}29`,
      })
      .select("id")
      .single();
    const overrideCallId = (
      await admin
        .from("calls")
        .insert({
          lead_id: overrideLead.data!.id,
          campaign_id: campaignId,
          agent_id: agentId,
          twilio_number_id: twilioNumberId,
          direction: "outbound",
          status: "completed",
          outcome: "voicemail",
          outcome_source: "twilio",
        })
        .select("id")
        .single()
    ).data!.id;
    leadIds.push(overrideLead.data!.id);
    callIds.push(overrideCallId);

    await page.goto(`/calls?call=${overrideCallId}`);
    // Scope to the sheet so the page's Outcome filter doesn't collide with
    // the modal's Outcome override.
    const sheet = page.getByRole("dialog");
    await sheet.getByLabel("Outcome").click();
    await page.getByRole("option", { name: "Not interested" }).click();
    await sheet.getByRole("button", { name: "Save outcome" }).click();
    await expect(page.getByText("Outcome updated.")).toBeVisible();

    const { data: c } = await admin
      .from("calls")
      .select("outcome, outcome_source")
      .eq("id", overrideCallId)
      .single();
    expect(c?.outcome).toBe("not_interested");
    expect(c?.outcome_source).toBe("manual");

    // Audit trail captured the change.
    const { data: events } = await admin
      .from("system_events")
      .select("kind, payload, actor_user_id")
      .eq("ref_id", overrideCallId);
    expect((events ?? []).length).toBeGreaterThanOrEqual(1);
    const ev = events![0];
    expect(ev.kind).toBe("outcome_override");
    expect(ev.actor_user_id).toBe(ownerId);
    expect(ev.payload).toMatchObject({
      from: "voicemail",
      to: "not_interested",
    });
  });

  test("scheduling a callback from the modal writes a callbacks row", async ({
    page,
  }) => {
    // Seed a call we can schedule a callback on.
    const cbLead = await admin
      .from("leads")
      .insert({
        owner_id: ownerId,
        list_id: listId,
        company: `E2E Calls Callback ${stamp}`,
        business_phone: `+1444${tail}39`,
      })
      .select("id")
      .single();
    const cbCallId = (
      await admin
        .from("calls")
        .insert({
          lead_id: cbLead.data!.id,
          campaign_id: campaignId,
          agent_id: agentId,
          twilio_number_id: twilioNumberId,
          direction: "outbound",
          status: "completed",
          outcome: "gatekeeper",
        })
        .select("id")
        .single()
    ).data!.id;
    leadIds.push(cbLead.data!.id);
    callIds.push(cbCallId);

    await page.goto(`/calls?call=${cbCallId}`);
    await page.getByRole("button", { name: "Schedule callback" }).click();
    // Pick a time a couple of hours in the future. The native datetime-local
    // input wants "yyyy-MM-ddTHH:mm".
    const future = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const localISO = `${future.getFullYear()}-${String(
      future.getMonth() + 1,
    ).padStart(2, "0")}-${String(future.getDate()).padStart(2, "0")}T${String(
      future.getHours(),
    ).padStart(2, "0")}:${String(future.getMinutes()).padStart(2, "0")}`;
    await page.getByLabel("When").fill(localISO);
    await page.getByRole("button", { name: "Schedule", exact: true }).click();
    await expect(page.getByText("Callback scheduled.")).toBeVisible();

    const { data: cb } = await admin
      .from("callbacks")
      .select("status, scheduled_at, created_by, originating_call_id")
      .eq("originating_call_id", cbCallId)
      .single();
    expect(cb?.status).toBe("pending");
    expect(cb?.created_by).toBe(ownerId);
    expect(cb?.originating_call_id).toBe(cbCallId);
    // Scheduled within a minute of the picked time.
    const scheduled = new Date(cb!.scheduled_at).getTime();
    expect(Math.abs(scheduled - future.getTime())).toBeLessThan(60_000);
  });
});
