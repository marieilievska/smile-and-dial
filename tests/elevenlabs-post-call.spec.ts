import { test, expect, request as playwrightRequest } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.describe.configure({ mode: "serial" });

/**
 * Drives the ElevenLabs post-call webhook end-to-end:
 *  - Seed a `calls` row keyed on a known elevenlabs_conversation_id.
 *  - POST a synthetic post-call payload, assert the call row picks up
 *    outcome / transcript / summary / score / extracted_data / cost.
 *  - Assert the LEAD's empty contact fields got auto-filled from the
 *    extracted data, but a pre-filled field stays put.
 *  - Replay the same POST → second one is ignored (idempotency).
 *  - Unknown conversation_id returns 200 with status "unknown_conversation".
 */
test.describe("ElevenLabs post-call webhook", () => {
  const stamp = Date.now();
  const conversationId = `convo-${stamp}`;

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
      .insert({ owner_id: ownerId, name: `E2E EL Webhook List ${stamp}` })
      .select("id")
      .single();
    listId = list!.id;

    const { data: num } = await admin
      .from("twilio_numbers")
      .insert({
        phone_number: `+1555${String(stamp).slice(-6)}30`,
        friendly_name: `E2E EL Webhook Number ${stamp}`,
        country: "US",
      })
      .select("id")
      .single();
    twilioNumberId = num!.id;

    const { data: agent } = await admin
      .from("agents")
      .insert({
        owner_id: ownerId,
        name: `E2E EL Webhook Agent ${stamp}`,
        elevenlabs_agent_id: `el-agent-${stamp}`,
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
      .insert({ owner_id: ownerId, name: `E2E EL Webhook Goal ${stamp}` })
      .select("id")
      .single();
    goalId = goal!.id;

    const { data: campaign } = await admin
      .from("campaigns")
      .insert({
        owner_id: ownerId,
        name: `E2E EL Webhook Campaign ${stamp}`,
        status: "active",
        agent_id: agentId,
        goal_id: goalId,
        twilio_number_id: twilioNumberId,
      })
      .select("id")
      .single();
    campaignId = campaign!.id;

    // Seed a lead with `business_email` already filled — the webhook should
    // NOT overwrite it. owner_name / manager_name are null so they should
    // get auto-filled.
    const { data: lead } = await admin
      .from("leads")
      .insert({
        owner_id: ownerId,
        list_id: listId,
        company: `E2E EL Co ${stamp}`,
        business_phone: `+1555${String(stamp).slice(-6)}20`,
        business_email: "preexisting@example.com",
      })
      .select("id")
      .single();
    leadId = lead!.id;

    // Seed the call row already stamped with twilio cost (mimicking what
    // Twilio status webhook would have set). ElevenLabs's cost should merge
    // on top, not replace it.
    const { data: call } = await admin
      .from("calls")
      .insert({
        lead_id: leadId,
        campaign_id: campaignId,
        agent_id: agentId,
        twilio_number_id: twilioNumberId,
        direction: "outbound",
        status: "completed",
        elevenlabs_conversation_id: conversationId,
        cost_breakdown: { twilio: 0.02, total: 0.02 },
      })
      .select("id")
      .single();
    callId = call!.id;
  });

  test.afterAll(async () => {
    await admin
      .from("elevenlabs_webhook_events")
      .delete()
      .like("conversation_id", `convo-${stamp}%`);
    await admin
      .from("elevenlabs_webhook_events")
      .delete()
      .eq("conversation_id", "UNKNOWN_CONVO");
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

  function buildPayload(id: string) {
    return {
      conversation_id: id,
      transcript: [
        { role: "agent", text: "Hi, this is Sara at Referrizer." },
        { role: "user", text: "Hi, this is Mike." },
      ],
      analysis: {
        summary: "Lead asked us to call back next Tuesday at 2pm.",
        data_collection: {
          disposition: "callback",
          business_email: "mike@example.com",
          owner_name: "Mike Johnson",
          manager_name: "Jane Smith",
          callback_datetime: "2026-06-02T14:00:00-05:00",
        },
        evaluation: { score: 7.5 },
      },
      metadata: {
        duration_seconds: 92,
        talk_time_seconds: 71,
        recording_url: "https://example.com/rec.mp3",
        cost: { elevenlabs: 0.05, openai: 0.01 },
      },
    };
  }

  test("the webhook writes outcome, transcript, summary, score, cost", async () => {
    const context = await playwrightRequest.newContext({
      baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
      storageState: undefined,
    });
    const res = await context.post("/api/elevenlabs/post-call", {
      headers: { "content-type": "application/json" },
      data: buildPayload(conversationId),
    });
    expect(res.ok()).toBe(true);
    expect(await res.json()).toEqual({ status: "applied" });

    const { data: c } = await admin
      .from("calls")
      .select(
        "outcome, outcome_source, goal_met, summary, score, transcript_json, extracted_data, duration_seconds, talk_time_seconds, recording_path, cost_breakdown",
      )
      .eq("id", callId)
      .single();
    expect(c?.outcome).toBe("callback");
    expect(c?.outcome_source).toBe("elevenlabs");
    expect(c?.goal_met).toBe(false);
    expect(c?.summary).toContain("call back next Tuesday");
    expect(c?.score).toBe(7.5);
    expect(c?.duration_seconds).toBe(92);
    expect(c?.talk_time_seconds).toBe(71);
    expect(c?.recording_path).toBe("https://example.com/rec.mp3");
    expect(c?.transcript_json).not.toBeNull();
    expect(c?.extracted_data).toMatchObject({ disposition: "callback" });
    // Cost merged: twilio kept, elevenlabs/openai added, total recomputed.
    expect(c?.cost_breakdown).toMatchObject({
      twilio: 0.02,
      elevenlabs: 0.05,
      openai: 0.01,
      total: 0.08,
    });

    await context.dispose();
  });

  test("empty lead fields are auto-filled, filled fields stay put", async () => {
    const { data: lead } = await admin
      .from("leads")
      .select("business_email, owner_name, manager_name, employee_name")
      .eq("id", leadId)
      .single();
    // business_email was pre-filled with "preexisting@example.com" — it
    // must NOT have been overwritten.
    expect(lead?.business_email).toBe("preexisting@example.com");
    // owner_name and manager_name were null — they should be filled now.
    expect(lead?.owner_name).toBe("Mike Johnson");
    expect(lead?.manager_name).toBe("Jane Smith");
    // employee_name wasn't in the extracted data — should still be null.
    expect(lead?.employee_name).toBeNull();
  });

  test("a replayed webhook returns duplicate and changes nothing", async () => {
    const context = await playwrightRequest.newContext({
      baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
      storageState: undefined,
    });
    const before = await admin
      .from("calls")
      .select("summary, score")
      .eq("id", callId)
      .single();

    const res = await context.post("/api/elevenlabs/post-call", {
      headers: { "content-type": "application/json" },
      // Even with a different score, the duplicate should be a no-op.
      data: {
        ...buildPayload(conversationId),
        analysis: { evaluation: { score: 1.0 } },
      },
    });
    expect(res.ok()).toBe(true);
    expect(await res.json()).toEqual({ status: "duplicate" });

    const after = await admin
      .from("calls")
      .select("summary, score")
      .eq("id", callId)
      .single();
    expect(after.data?.summary).toBe(before.data?.summary);
    expect(after.data?.score).toBe(before.data?.score);

    await context.dispose();
  });

  test("an unknown conversation_id returns unknown_conversation", async () => {
    const context = await playwrightRequest.newContext({
      baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
      storageState: undefined,
    });
    const res = await context.post("/api/elevenlabs/post-call", {
      headers: { "content-type": "application/json" },
      data: { conversation_id: "UNKNOWN_CONVO" },
    });
    expect(res.ok()).toBe(true);
    expect(await res.json()).toEqual({ status: "unknown_conversation" });
    await context.dispose();
  });

  test("a goal_met disposition flips goal_met on the call row", async () => {
    // Fresh call for a fresh conversation id.
    const convo = `convo-${stamp}-goal`;
    const { data: call } = await admin
      .from("calls")
      .insert({
        lead_id: leadId,
        campaign_id: campaignId,
        agent_id: agentId,
        twilio_number_id: twilioNumberId,
        direction: "outbound",
        status: "completed",
        elevenlabs_conversation_id: convo,
      })
      .select("id")
      .single();
    try {
      const context = await playwrightRequest.newContext({
        baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
        storageState: undefined,
      });
      const res = await context.post("/api/elevenlabs/post-call", {
        headers: { "content-type": "application/json" },
        data: {
          conversation_id: convo,
          analysis: { data_collection: { disposition: "goal_met" } },
        },
      });
      expect(res.ok()).toBe(true);
      const { data } = await admin
        .from("calls")
        .select("outcome, goal_met")
        .eq("id", call!.id)
        .single();
      expect(data?.outcome).toBe("goal_met");
      expect(data?.goal_met).toBe(true);
      await context.dispose();
    } finally {
      await admin
        .from("elevenlabs_webhook_events")
        .delete()
        .eq("conversation_id", convo);
      await admin.from("calls").delete().eq("id", call!.id);
    }
  });
});
