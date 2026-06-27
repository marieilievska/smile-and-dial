import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.describe.configure({ mode: "serial" });

/**
 * Reporting scope filter (campaign-only):
 *  - The scope picker is present and offers only All + campaign options (no
 *    agent options).
 *  - A campaign WITH sentiment data shows the dashboard's Yes/Maybe/No columns
 *    and the interest tabs (Voice of Customer + Hot Leads).
 *  - The Voice of Customer tab renders the sentiment pill + notes + recording
 *    player + a clickable lead link (admin only).
 *  - The Hot Leads tab is a live list of the campaign's warm calls (yes +
 *    maybe, not no) with Contact / Why hot / List columns (no Status / Owner),
 *    a lead link, and a permanent dismissal that removes a row.
 *  - A campaign WITHOUT sentiment data hides the dashboard sentiment columns
 *    and the interest tabs; the combined (All) view also hides the sentiment
 *    columns.
 *  - The admin recording redirect route resolves a known call and 404s an
 *    unknown one.
 *  - The App Changelog is a read-only table (Date header, no Owner header).
 */
test.describe("Reporting scope filter", () => {
  const stamp = Date.now();
  let admin: SupabaseClient;
  let ownerId: string;
  let agentId: string;
  let goalId: string;
  let listId: string;
  let leadId: string;
  let interestCampaignId: string;
  let plainCampaignId: string;
  let voiceCallId: string;
  let maybeCallId: string;
  const callIds: string[] = [];
  const dismissedCallIds: string[] = [];
  // Prompt-log per-agent fixtures: two agents, each with one prompt-log entry,
  // and a campaign whose agent is A — so the campaign-scoped prompt log shows
  // only A's entry while the combined view shows both.
  let promptAgentAId: string;
  let promptAgentBId: string;
  let promptAgentAName: string;
  let promptAgentBName: string;
  let promptCampaignId: string;
  const promptLogIds: string[] = [];

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

    const { data: agent } = await admin
      .from("agents")
      .insert({
        owner_id: ownerId,
        name: `E2E Scope Agent ${stamp}`,
        prompt_personality: "x",
        prompt_environment: "x",
        prompt_tone: "x",
        prompt_goal: "x",
        prompt_guardrails: "x",
      })
      .select("id")
      .single();
    agentId = agent!.id as string;

    const { data: goal } = await admin
      .from("goals")
      .insert({ owner_id: ownerId, name: `E2E Scope Goal ${stamp}` })
      .select("id")
      .single();
    goalId = goal!.id;

    const mkCampaign = async (name: string) => {
      const { data } = await admin
        .from("campaigns")
        .insert({ owner_id: ownerId, agent_id: agentId, goal_id: goalId, name })
        .select("id")
        .single();
      return data!.id as string;
    };
    interestCampaignId = await mkCampaign(`E2E Scope Interest ${stamp}`);
    plainCampaignId = await mkCampaign(`E2E Scope Plain ${stamp}`);

    const { data: list } = await admin
      .from("lists")
      .insert({ owner_id: ownerId, name: `E2E Scope List ${stamp}` })
      .select("id")
      .single();
    listId = list!.id as string;

    const { data: lead } = await admin
      .from("leads")
      .insert({
        owner_id: ownerId,
        company: `E2E Scope Co ${stamp}`,
        business_phone: `+1555${String(stamp).slice(-7)}`,
        status: "ready_to_call",
        owner_name: `E2E Owner ${stamp}`,
        list_id: listId,
      })
      .select("id")
      .single();
    leadId = lead!.id;

    const insertCall = async (
      campaignId: string,
      extracted: Record<string, unknown> | null,
      recordingPath: string | null = null,
    ) => {
      const { data } = await admin
        .from("calls")
        .insert({
          lead_id: leadId,
          agent_id: agentId,
          campaign_id: campaignId,
          goal_id: goalId,
          direction: "outbound",
          status: "completed",
          outcome: "completed",
          duration_seconds: 80,
          started_at: new Date().toISOString(),
          extracted_data: extracted,
          recording_path: recordingPath,
        })
        .select("id")
        .single();
      callIds.push(data!.id as string);
      return data!.id as string;
    };
    // The interest campaign: a categorical sentiment field + a long-text notes
    // field. The first call carries an http recording_path so the redirect uses
    // the legacy http branch (no storage signing).
    voiceCallId = await insertCall(
      interestCampaignId,
      {
        ai_call_answering_interest: "yes",
        ai_call_answering_reason:
          "They were very enthusiastic about an AI answering service and asked for pricing details right away.",
      },
      "https://example.com/rec.mp3",
    );
    maybeCallId = await insertCall(interestCampaignId, {
      ai_call_answering_interest: "maybe",
      ai_call_answering_reason:
        "On the fence — they already use a part-time receptionist but might switch.",
    });
    await insertCall(interestCampaignId, {
      ai_call_answering_interest: "no",
      ai_call_answering_reason:
        "Not interested at this time; happy with their current phone setup.",
    });
    await insertCall(plainCampaignId, {});

    // --- Prompt-log per-agent fixtures ---
    promptAgentAName = `E2E Prompt Agent A ${stamp}`;
    promptAgentBName = `E2E Prompt Agent B ${stamp}`;
    const mkPromptAgent = async (name: string) => {
      const { data } = await admin
        .from("agents")
        .insert({
          owner_id: ownerId,
          name,
          prompt_personality: "x",
          prompt_environment: "x",
          prompt_tone: "x",
          prompt_goal: "x",
          prompt_guardrails: "x",
        })
        .select("id")
        .single();
      return data!.id as string;
    };
    promptAgentAId = await mkPromptAgent(promptAgentAName);
    promptAgentBId = await mkPromptAgent(promptAgentBName);

    const mkPromptLog = async (agentForLog: string, prompt: string) => {
      const { data } = await admin
        .from("agent_prompt_log")
        .insert({
          agent_id: agentForLog,
          version: "v1",
          changed: "No change",
          full_prompt: prompt,
        })
        .select("id")
        .single();
      promptLogIds.push(data!.id as string);
    };
    await mkPromptLog(promptAgentAId, `Prompt for agent A ${stamp}`);
    await mkPromptLog(promptAgentBId, `Prompt for agent B ${stamp}`);

    // The campaign whose agent is A — its prompt-log view shows only A.
    const { data: promptCampaign } = await admin
      .from("campaigns")
      .insert({
        owner_id: ownerId,
        agent_id: promptAgentAId,
        goal_id: goalId,
        name: `E2E Prompt Campaign ${stamp}`,
      })
      .select("id")
      .single();
    promptCampaignId = promptCampaign!.id as string;
  });

  test.afterAll(async () => {
    for (const id of dismissedCallIds)
      await admin.from("hot_lead_dismissals").delete().eq("call_id", id);
    for (const id of callIds) await admin.from("calls").delete().eq("id", id);
    for (const id of promptLogIds)
      await admin.from("agent_prompt_log").delete().eq("id", id);
    await admin
      .from("campaigns")
      .delete()
      .eq("id", promptCampaignId ?? "");
    await admin
      .from("agents")
      .delete()
      .eq("id", promptAgentAId ?? "");
    await admin
      .from("agents")
      .delete()
      .eq("id", promptAgentBId ?? "");
    await admin
      .from("leads")
      .delete()
      .eq("id", leadId ?? "");
    await admin
      .from("lists")
      .delete()
      .eq("id", listId ?? "");
    await admin
      .from("campaigns")
      .delete()
      .eq("id", interestCampaignId ?? "");
    await admin
      .from("campaigns")
      .delete()
      .eq("id", plainCampaignId ?? "");
    await admin
      .from("agents")
      .delete()
      .eq("id", agentId ?? "");
    await admin
      .from("goals")
      .delete()
      .eq("id", goalId ?? "");
  });

  test("the picker has no agent options", async ({ page }) => {
    await page.goto("/reporting");
    await expect(page.locator("#reporting-scope")).toBeVisible();
    // No agent-scoped options exist in the campaigns-only picker.
    await expect(
      page.locator('#reporting-scope option[value^="agent:"]'),
    ).toHaveCount(0);
  });

  test("a campaign with sentiment data shows the Yes column + interest tabs", async ({
    page,
  }) => {
    await page.goto(`/reporting?scope=campaign:${interestCampaignId}`);
    await expect(page.locator("#reporting-scope")).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Yes" })).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Voice of Customer" }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Hot Leads" })).toBeVisible();
  });

  test("the Voice of Customer tab shows sentiment + recording + a lead link", async ({
    page,
  }) => {
    await page.goto(
      `/reporting?scope=campaign:${interestCampaignId}&tab=voice`,
    );
    // Sentiment column header + a Play control for the call with a recording.
    await expect(
      page.getByRole("columnheader", { name: "Sentiment" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /play/i }).first(),
    ).toBeVisible();
    // The company cell links to the lead (admin view only).
    await expect(
      page.getByRole("link", { name: `E2E Scope Co ${stamp}` }).first(),
    ).toHaveAttribute("href", `/leads/${leadId}`);
  });

  test("the Hot Leads tab lists the warm calls (yes + maybe, not no)", async ({
    page,
  }) => {
    await page.goto(
      `/reporting?scope=campaign:${interestCampaignId}&tab=hot-leads`,
    );
    // The simplified columns — Contact / Why hot / List — and none of the old
    // editable hot-leads columns (Status / Owner).
    await expect(
      page.getByRole("columnheader", { name: "Contact" }),
    ).toBeVisible();
    await expect(
      page.getByRole("columnheader", { name: "Why hot" }),
    ).toBeVisible();
    await expect(
      page.getByRole("columnheader", { name: "List" }),
    ).toBeVisible();
    await expect(
      page.getByRole("columnheader", { name: "Status" }),
    ).toHaveCount(0);
    await expect(page.getByRole("columnheader", { name: "Owner" })).toHaveCount(
      0,
    );
    // Both warm calls (yes + maybe) reference the same lead, so the company
    // appears as an admin lead link; the "no" call is filtered out (it's not
    // warm), so exactly the two warm rows render.
    const companyLink = page.getByRole("link", {
      name: `E2E Scope Co ${stamp}`,
    });
    await expect(companyLink.first()).toHaveAttribute(
      "href",
      `/leads/${leadId}`,
    );
    await expect(companyLink).toHaveCount(2);
  });

  test("dismissing a warm call hides it from Hot Leads on reload", async () => {
    // Record a dismissal for the "maybe" call directly (service client).
    await admin.from("hot_lead_dismissals").insert({ call_id: maybeCallId });
    dismissedCallIds.push(maybeCallId);
  });

  test("the dismissed warm call no longer appears", async ({ page }) => {
    await page.goto(
      `/reporting?scope=campaign:${interestCampaignId}&tab=hot-leads`,
    );
    // Only the "yes" call's row remains → a single company link.
    await expect(
      page.getByRole("link", { name: `E2E Scope Co ${stamp}` }),
    ).toHaveCount(1);
  });

  test("the admin recording route resolves a known call and 404s an unknown one", async ({
    page,
  }) => {
    // Authenticated context (the page fixture carries the admin session); the
    // seeded call has an http recording_path so the route 3xx-redirects to it.
    const ok = await page.request.get(
      `/api/reporting/recording/${voiceCallId}`,
      { maxRedirects: 0 },
    );
    expect(ok.status()).toBeLessThan(400);
    const missing = await page.request.get(
      `/api/reporting/recording/00000000-0000-0000-0000-000000000000`,
      { maxRedirects: 0 },
    );
    expect(missing.status()).toBe(404);
  });

  test("a campaign without sentiment data hides the Yes column + interest tabs", async ({
    page,
  }) => {
    await page.goto(`/reporting?scope=campaign:${plainCampaignId}`);
    await expect(page.locator("#reporting-scope")).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Yes" })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("link", { name: "Voice of Customer" }),
    ).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Hot Leads" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible();
  });

  test("the combined view hides the Yes column", async ({ page }) => {
    await page.goto("/reporting?scope=all");
    await expect(page.getByRole("columnheader", { name: "Yes" })).toHaveCount(
      0,
    );
  });

  test("the App Changelog is a read-only table with no Owner header", async ({
    page,
  }) => {
    await page.goto("/reporting?tab=changelog");
    await expect(
      page.getByRole("columnheader", { name: "Date" }),
    ).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Owner" })).toHaveCount(
      0,
    );
  });

  test("the combined prompt log shows every agent's entries", async ({
    page,
  }) => {
    await page.goto("/reporting?scope=all&tab=prompt-log");
    await expect(page.getByText(promptAgentAName).first()).toBeVisible();
    await expect(page.getByText(promptAgentBName).first()).toBeVisible();
  });

  test("a campaign-scoped prompt log shows only that campaign's agent", async ({
    page,
  }) => {
    await page.goto(
      `/reporting?scope=campaign:${promptCampaignId}&tab=prompt-log`,
    );
    await expect(page.getByText(promptAgentAName).first()).toBeVisible();
    await expect(page.getByText(promptAgentBName)).toHaveCount(0);
  });

  test("the Add form exposes an agent picker", async ({ page }) => {
    await page.goto("/reporting?scope=all&tab=prompt-log");
    await page.getByRole("button", { name: "Add entry" }).click();
    await expect(page.getByRole("combobox").first()).toBeVisible();
    await expect(
      page.getByRole("option", { name: promptAgentAName }),
    ).toHaveCount(1);
  });
});
