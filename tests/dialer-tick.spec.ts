import { test, expect, request as playwrightRequest } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.use({ storageState: "playwright/.auth/user.json" });

test.describe.configure({ mode: "serial" });

/**
 * One full pass through the mocked dial loop:
 *   - Seed a lead in the queue.
 *   - POST to /api/dialer/tick (authenticated as admin via storageState).
 *   - Assert: a `calls` row was inserted with a sensible outcome, the lead
 *     was bumped, and the tick's summary reports `dialed = 1`.
 *
 * Live Twilio/ElevenLabs paths are intentionally not exercised here — the
 * tick logic throws when either is configured `live`, so a misconfigured
 * env can't quietly burn through call credits.
 */
test.describe("Dialer tick", () => {
  const stamp = Date.now();
  const tail = String(stamp).slice(-6);
  const phone = `+1555${tail}70`;

  let admin: SupabaseClient;
  let ownerId: string;
  let listId: string;
  let twilioNumberId: string;
  let campaignId: string;
  let leadId: string;
  let agentId: string;
  let goalId: string;

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
      .insert({ owner_id: ownerId, name: `E2E Tick List ${stamp}` })
      .select("id")
      .single();
    listId = list!.id;

    const { data: num } = await admin
      .from("twilio_numbers")
      .insert({
        phone_number: `+1555${tail}60`,
        friendly_name: `E2E Tick Number ${stamp}`,
        country: "US",
      })
      .select("id")
      .single();
    twilioNumberId = num!.id;

    const { data: agent } = await admin
      .from("agents")
      .insert({
        owner_id: ownerId,
        name: `E2E Tick Agent ${stamp}`,
        elevenlabs_agent_id: `e2e-tick-${stamp}`,
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
      .insert({ owner_id: ownerId, name: `E2E Tick Goal ${stamp}` })
      .select("id")
      .single();
    goalId = goal!.id;

    const { data: campaign } = await admin
      .from("campaigns")
      .insert({
        owner_id: ownerId,
        name: `E2E Tick Campaign ${stamp}`,
        status: "active",
        agent_id: agentId,
        goal_id: goalId,
        twilio_number_id: twilioNumberId,
      })
      .select("id")
      .single();
    campaignId = campaign!.id;

    await admin
      .from("twilio_numbers")
      .update({ attached_campaign_id: campaignId })
      .eq("id", twilioNumberId);
    await admin
      .from("list_campaign_attachments")
      .insert({ list_id: listId, campaign_id: campaignId });

    const { data: lead } = await admin
      .from("leads")
      .insert({
        owner_id: ownerId,
        list_id: listId,
        company: `E2E Tick Co ${stamp}`,
        business_phone: phone,
        timezone: "America/New_York",
        status: "ready_to_call",
      })
      .select("id")
      .single();
    leadId = lead!.id;
  });

  test.afterAll(async () => {
    await admin
      .from("calls")
      .delete()
      .eq("lead_id", leadId ?? "");
    await admin
      .from("leads")
      .delete()
      .eq("id", leadId ?? "");
    await admin
      .from("list_campaign_attachments")
      .delete()
      .eq("campaign_id", campaignId ?? "");
    await admin
      .from("twilio_numbers")
      .update({ attached_campaign_id: null })
      .eq("id", twilioNumberId ?? "");
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

  test("the tick dials a queued lead and writes a mock call row", async ({
    page,
  }) => {
    const before = await admin
      .from("leads")
      .select("call_attempts, next_call_at, last_call_at")
      .eq("id", leadId)
      .single();
    expect(before.data?.call_attempts).toBe(0);
    expect(before.data?.last_call_at).toBeNull();

    // Fire one tick. The session cookies in storageState authenticate us as
    // the e2e admin; the route also accepts an x-dialer-secret header but
    // we don't need it here.
    const response = await page.request.post("/api/dialer/tick");
    expect(response.ok()).toBe(true);
    const summary = await response.json();
    expect(summary.candidates).toBeGreaterThanOrEqual(1);
    expect(summary.dialed).toBeGreaterThanOrEqual(1);

    // The call row exists with a believable mock outcome.
    const { data: calls } = await admin
      .from("calls")
      .select("status, outcome, direction, duration_seconds, cost_breakdown")
      .eq("lead_id", leadId);
    expect(calls?.length ?? 0).toBeGreaterThanOrEqual(1);
    const call = calls![0];
    expect(call.status).toBe("completed");
    expect(call.direction).toBe("outbound");
    expect(call.outcome).not.toBeNull();
    expect(call.duration_seconds).toBeGreaterThan(0);
    expect((call.cost_breakdown as { total: number } | null)?.total).toBe(0.07);

    // The lead was bumped.
    const { data: after } = await admin
      .from("leads")
      .select("call_attempts, next_call_at, last_call_at")
      .eq("id", leadId)
      .single();
    expect(after?.call_attempts).toBe(1);
    expect(after?.last_call_at).not.toBeNull();
    expect(after?.next_call_at).not.toBeNull();
  });

  test("the endpoint refuses unauthorized POSTs", async () => {
    // Build a request context that explicitly has no auth cookies.
    const context = await playwrightRequest.newContext({
      baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
      storageState: undefined,
    });
    const response = await context.post("/api/dialer/tick");
    expect(response.status()).toBe(401);
    await context.dispose();
  });
});
