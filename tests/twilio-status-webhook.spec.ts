import { test, expect, request as playwrightRequest } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.describe.configure({ mode: "serial" });

/**
 * Drives the Twilio status webhook end-to-end:
 *  - Seed a `calls` row keyed on a known `twilio_call_sid`.
 *  - POST a sequence of status callbacks (initiated → ringing → answered
 *    → completed) and assert each one advances `calls.status`.
 *  - Replay the final POST and assert the second one is ignored (idempotency).
 *  - Confirm an unknown CallSid returns 200 with status "unknown_call".
 */
test.describe("Twilio status webhook", () => {
  const stamp = Date.now();
  const callSid = `CAtest${stamp}`;

  let admin: SupabaseClient;
  let ownerId: string;
  let listId: string;
  let twilioNumberId: string;
  let campaignId: string;
  let leadId: string;
  let agentId: string;
  let goalId: string;
  let callId: string;

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
      .insert({ owner_id: ownerId, name: `E2E Webhook List ${stamp}` })
      .select("id")
      .single();
    listId = list!.id;

    const { data: num } = await admin
      .from("twilio_numbers")
      .insert({
        phone_number: `+1555${String(stamp).slice(-6)}50`,
        friendly_name: `E2E Webhook Number ${stamp}`,
        country: "US",
      })
      .select("id")
      .single();
    twilioNumberId = num!.id;

    const { data: agent } = await admin
      .from("agents")
      .insert({
        owner_id: ownerId,
        name: `E2E Webhook Agent ${stamp}`,
        elevenlabs_agent_id: `e2e-webhook-${stamp}`,
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
      .insert({ owner_id: ownerId, name: `E2E Webhook Goal ${stamp}` })
      .select("id")
      .single();
    goalId = goal!.id;

    const { data: campaign } = await admin
      .from("campaigns")
      .insert({
        owner_id: ownerId,
        name: `E2E Webhook Campaign ${stamp}`,
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
        company: `E2E Webhook Co ${stamp}`,
        business_phone: `+1555${String(stamp).slice(-6)}40`,
      })
      .select("id")
      .single();
    leadId = lead!.id;

    // Seed a calls row in `queued` state with a known Twilio SID — this is
    // what the webhook events will progress through.
    const { data: call } = await admin
      .from("calls")
      .insert({
        lead_id: leadId,
        campaign_id: campaignId,
        agent_id: agentId,
        twilio_number_id: twilioNumberId,
        direction: "outbound",
        status: "queued",
        twilio_call_sid: callSid,
      })
      .select("id")
      .single();
    callId = call!.id;
  });

  test.afterAll(async () => {
    await admin.from("twilio_status_events").delete().eq("call_sid", callSid);
    await admin
      .from("twilio_status_events")
      .delete()
      .eq("call_sid", "UNKNOWN_SID");
    await admin
      .from("calls")
      .delete()
      .eq("id", callId ?? "");
    await admin
      .from("leads")
      .delete()
      .eq("id", leadId ?? "");
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

  async function postStatus(
    request: ReturnType<typeof playwrightRequest.newContext> extends Promise<
      infer T
    >
      ? T
      : never,
    callStatus: string,
    extra: Record<string, string> = {},
  ) {
    const form = new URLSearchParams({
      CallSid: callSid,
      CallStatus: callStatus,
      AccountSid: "ACtest",
      ...extra,
    });
    return await request.post("/api/twilio/status", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      data: form.toString(),
    });
  }

  test("the webhook walks a call through its lifecycle and stays idempotent", async () => {
    const context = await playwrightRequest.newContext({
      baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
      storageState: undefined,
    });

    // initiated → dialing
    let res = await postStatus(context, "initiated");
    expect(res.ok()).toBe(true);
    expect(await res.json()).toEqual({ status: "applied" });
    let { data: c } = await admin
      .from("calls")
      .select("status, started_at, answered_at, ended_at, outcome")
      .eq("id", callId)
      .single();
    expect(c?.status).toBe("dialing");
    expect(c?.started_at).not.toBeNull();

    // ringing → ringing (no answered_at yet)
    res = await postStatus(context, "ringing");
    expect(res.ok()).toBe(true);
    ({ data: c } = await admin
      .from("calls")
      .select("status, answered_at")
      .eq("id", callId)
      .single());
    expect(c?.status).toBe("ringing");
    expect(c?.answered_at).toBeNull();

    // answered → in_progress, stamp answered_at
    res = await postStatus(context, "answered");
    expect(res.ok()).toBe(true);
    ({ data: c } = await admin
      .from("calls")
      .select("status, answered_at")
      .eq("id", callId)
      .single());
    expect(c?.status).toBe("in_progress");
    expect(c?.answered_at).not.toBeNull();

    // completed → completed, stamp ended_at and CallDuration
    res = await postStatus(context, "completed", { CallDuration: "47" });
    expect(res.ok()).toBe(true);
    expect(await res.json()).toEqual({ status: "applied" });
    ({ data: c } = await admin
      .from("calls")
      .select("status, ended_at, duration_seconds, outcome")
      .eq("id", callId)
      .single());
    expect(c?.status).toBe("completed");
    expect(c?.ended_at).not.toBeNull();
    expect(c?.duration_seconds).toBe(47);
    // `completed` alone doesn't set an outcome — that comes from ElevenLabs.
    expect(c?.outcome).toBeNull();

    // Replay the same completed event → idempotent, no change.
    const before = await admin
      .from("calls")
      .select("ended_at, duration_seconds")
      .eq("id", callId)
      .single();
    res = await postStatus(context, "completed", { CallDuration: "47" });
    expect(res.ok()).toBe(true);
    expect(await res.json()).toEqual({ status: "duplicate" });
    const after = await admin
      .from("calls")
      .select("ended_at, duration_seconds")
      .eq("id", callId)
      .single();
    expect(after.data?.ended_at).toBe(before.data?.ended_at);
    expect(after.data?.duration_seconds).toBe(47);

    await context.dispose();
  });

  test("an unknown CallSid returns 200 with status unknown_call", async () => {
    const context = await playwrightRequest.newContext({
      baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
      storageState: undefined,
    });
    const form = new URLSearchParams({
      CallSid: "UNKNOWN_SID",
      CallStatus: "completed",
      AccountSid: "ACtest",
    });
    const res = await context.post("/api/twilio/status", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      data: form.toString(),
    });
    expect(res.ok()).toBe(true);
    expect(await res.json()).toEqual({ status: "unknown_call" });
    await context.dispose();
  });

  test("a busy status sets outcome=busy automatically", async () => {
    // New CallSid + call row so the (sid, event) idempotency key is fresh.
    const sid = `${callSid}-busy`;
    const { data: busyCall } = await admin
      .from("calls")
      .insert({
        lead_id: leadId,
        campaign_id: campaignId,
        agent_id: agentId,
        twilio_number_id: twilioNumberId,
        direction: "outbound",
        status: "queued",
        twilio_call_sid: sid,
      })
      .select("id")
      .single();
    try {
      const context = await playwrightRequest.newContext({
        baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
        storageState: undefined,
      });
      const form = new URLSearchParams({
        CallSid: sid,
        CallStatus: "busy",
        AccountSid: "ACtest",
      });
      const res = await context.post("/api/twilio/status", {
        headers: { "content-type": "application/x-www-form-urlencoded" },
        data: form.toString(),
      });
      expect(res.ok()).toBe(true);
      const { data } = await admin
        .from("calls")
        .select("status, outcome, outcome_source")
        .eq("id", busyCall!.id)
        .single();
      expect(data?.status).toBe("completed");
      expect(data?.outcome).toBe("busy");
      expect(data?.outcome_source).toBe("twilio");
      await context.dispose();
    } finally {
      await admin.from("twilio_status_events").delete().eq("call_sid", sid);
      await admin.from("calls").delete().eq("id", busyCall!.id);
    }
  });
});
