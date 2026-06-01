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
      .from("callbacks")
      .delete()
      .eq("lead_id", leadId ?? "");
    await admin
      .from("dnc_entries")
      .delete()
      .like("phone", `+1555${String(stamp).slice(-6)}%`);
    await admin
      .from("calls")
      .delete()
      .eq("lead_id", leadId ?? "");
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

    // The `callback` disposition also fires the side effect: a callback
    // row appears, lead.status moves to 'callback', and next_call_at is
    // set to the scheduled time the agent captured.
    const { data: cb } = await admin
      .from("callbacks")
      .select("status, scheduled_at, originating_call_id, created_by")
      .eq("lead_id", leadId)
      .eq("originating_call_id", callId);
    expect(cb?.length).toBe(1);
    expect(cb![0].status).toBe("pending");
    expect(cb![0].created_by).toBeNull();
    expect(new Date(cb![0].scheduled_at).toISOString()).toBe(
      new Date("2026-06-02T14:00:00-05:00").toISOString(),
    );
    const { data: leadAfter } = await admin
      .from("leads")
      .select("status, next_call_at")
      .eq("id", leadId)
      .single();
    expect(leadAfter?.status).toBe("callback");
    expect(leadAfter?.next_call_at).not.toBeNull();

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

  test("resolves the call via the echoed call_id when no conversation_id was pre-stamped", async () => {
    // The live-mode path: the dialer never knows the ElevenLabs
    // conversation_id up front, so the call row has none. We attach our
    // internal call_id to the Twilio <Stream> and ElevenLabs echoes it back
    // under conversation_initiation_client_data. The webhook must resolve
    // the row by that call_id and stamp the conversation_id onto it.
    const convo = `convo-${stamp}-echo`;
    const { data: call } = await admin
      .from("calls")
      .insert({
        lead_id: leadId,
        campaign_id: campaignId,
        agent_id: agentId,
        twilio_number_id: twilioNumberId,
        direction: "outbound",
        status: "in_progress",
        // NOTE: deliberately no elevenlabs_conversation_id here.
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
          conversation_initiation_client_data: {
            dynamic_variables: { call_id: call!.id },
          },
          analysis: {
            summary: "Echoed-id correlation works.",
            data_collection: { disposition: "not_interested" },
          },
        },
      });
      expect(res.ok()).toBe(true);
      expect(await res.json()).toEqual({ status: "applied" });

      const { data } = await admin
        .from("calls")
        .select("outcome, summary, elevenlabs_conversation_id")
        .eq("id", call!.id)
        .single();
      expect(data?.outcome).toBe("not_interested");
      expect(data?.summary).toBe("Echoed-id correlation works.");
      // The conversation_id was stamped onto the row for future replays.
      expect(data?.elevenlabs_conversation_id).toBe(convo);
      await context.dispose();
    } finally {
      await admin
        .from("elevenlabs_webhook_events")
        .delete()
        .eq("conversation_id", convo);
      await admin.from("calls").delete().eq("id", call!.id);
    }
  });

  test("disposition=dnc auto-inserts into DNC and sets lead status to dnc", async () => {
    // Fresh lead + call so we don't interfere with the callback-side-effect
    // lead from the earlier test.
    const stamp2 = Date.now();
    const phone = `+1555${String(stamp2).slice(-6)}10`;
    const convo = `convo-${stamp}-dnc`;

    const { data: dncLead } = await admin
      .from("leads")
      .insert({
        owner_id: ownerId,
        list_id: listId,
        company: `E2E DNC Co ${stamp2}`,
        business_phone: phone,
      })
      .select("id")
      .single();
    const { data: dncCall } = await admin
      .from("calls")
      .insert({
        lead_id: dncLead!.id,
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
          analysis: { data_collection: { disposition: "dnc" } },
        },
      });
      expect(res.ok()).toBe(true);

      const { data: dnc } = await admin
        .from("dnc_entries")
        .select("reason, source_call_id, company_snapshot")
        .eq("phone", phone)
        .single();
      expect(dnc?.reason).toBe("dnc_requested");
      expect(dnc?.source_call_id).toBe(dncCall!.id);
      expect(dnc?.company_snapshot).toBe(`E2E DNC Co ${stamp2}`);

      const { data: leadAfter } = await admin
        .from("leads")
        .select("status, next_call_at")
        .eq("id", dncLead!.id)
        .single();
      expect(leadAfter?.status).toBe("dnc");
      expect(leadAfter?.next_call_at).toBeNull();

      await context.dispose();
    } finally {
      await admin
        .from("elevenlabs_webhook_events")
        .delete()
        .eq("conversation_id", convo);
      await admin.from("dnc_entries").delete().eq("phone", phone);
      await admin.from("calls").delete().eq("id", dncCall!.id);
      await admin.from("leads").delete().eq("id", dncLead!.id);
    }
  });

  test("a callback with no callback_datetime falls back to ~tomorrow", async () => {
    const stamp2 = Date.now();
    const phone = `+1555${String(stamp2).slice(-6)}12`;
    const convo = `convo-${stamp}-cb-nodate`;
    const { data: l } = await admin
      .from("leads")
      .insert({
        owner_id: ownerId,
        list_id: listId,
        company: `E2E CB-NoDate Co ${stamp2}`,
        business_phone: phone,
      })
      .select("id")
      .single();
    const { data: c } = await admin
      .from("calls")
      .insert({
        lead_id: l!.id,
        campaign_id: campaignId,
        agent_id: agentId,
        direction: "outbound",
        status: "completed",
        elevenlabs_conversation_id: convo,
      })
      .select("id")
      .single();
    try {
      const ctx = await playwrightRequest.newContext({
        baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
        storageState: undefined,
      });
      const res = await ctx.post("/api/elevenlabs/post-call", {
        headers: { "content-type": "application/json" },
        data: {
          conversation_id: convo,
          // Note: no callback_datetime extracted.
          analysis: { data_collection: { disposition: "callback" } },
        },
      });
      expect(res.ok()).toBe(true);

      const { data: cb } = await admin
        .from("callbacks")
        .select("scheduled_at, status")
        .eq("lead_id", l!.id)
        .single();
      expect(cb?.status).toBe("pending");
      // The fallback should be roughly +24h. Allow a wide window.
      const scheduled = new Date(cb!.scheduled_at).getTime();
      const expected = Date.now() + 24 * 60 * 60 * 1000;
      expect(Math.abs(scheduled - expected)).toBeLessThan(60_000);

      await ctx.dispose();
    } finally {
      await admin
        .from("elevenlabs_webhook_events")
        .delete()
        .eq("conversation_id", convo);
      await admin.from("callbacks").delete().eq("lead_id", l!.id);
      await admin.from("calls").delete().eq("id", c!.id);
      await admin.from("leads").delete().eq("id", l!.id);
    }
  });

  test("the real { type, data } envelope is unwrapped and applied", async () => {
    const convo = `convo-${stamp}-env`;
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
      const ctx = await playwrightRequest.newContext({
        baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
      });
      const res = await ctx.post("/api/elevenlabs/post-call", {
        headers: { "content-type": "application/json" },
        // Production envelope: real fields nested under `data`.
        data: {
          type: "post_call_transcription",
          event_timestamp: 1739537297,
          data: {
            conversation_id: convo,
            analysis: {
              summary: "Envelope unwrapped correctly.",
              data_collection: { disposition: "not_interested" },
            },
          },
        },
      });
      expect(res.ok()).toBe(true);
      expect(await res.json()).toEqual({ status: "applied" });
      const { data } = await admin
        .from("calls")
        .select("outcome, summary")
        .eq("id", call!.id)
        .single();
      expect(data?.outcome).toBe("not_interested");
      expect(data?.summary).toBe("Envelope unwrapped correctly.");
      await ctx.dispose();
    } finally {
      await admin
        .from("elevenlabs_webhook_events")
        .delete()
        .eq("conversation_id", convo);
      await admin.from("calls").delete().eq("id", call!.id);
    }
  });

  test("post_call_audio stores the recording and sets recording_path", async () => {
    const convo = `convo-${stamp}-audio`;
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
      const ctx = await playwrightRequest.newContext({
        baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
      });
      // A tiny valid base64 blob stands in for the MP3.
      const fakeMp3 = Buffer.from("ID3-fake-audio-bytes").toString("base64");
      const res = await ctx.post("/api/elevenlabs/post-call", {
        headers: { "content-type": "application/json" },
        data: {
          type: "post_call_audio",
          event_timestamp: 1739537319,
          data: { conversation_id: convo, full_audio: fakeMp3 },
        },
      });
      expect(res.ok()).toBe(true);
      expect(await res.json()).toEqual({ status: "applied" });

      const { data } = await admin
        .from("calls")
        .select("recording_path")
        .eq("id", call!.id)
        .single();
      expect(data?.recording_path).toBe(`${call!.id}.mp3`);

      // The object actually landed in the bucket.
      const { data: dl } = await admin.storage
        .from("call-recordings")
        .download(`${call!.id}.mp3`);
      expect(dl).not.toBeNull();
      await ctx.dispose();
    } finally {
      await admin.storage.from("call-recordings").remove([`${call!.id}.mp3`]);
      await admin
        .from("elevenlabs_webhook_events")
        .delete()
        .eq("conversation_id", convo);
      await admin.from("calls").delete().eq("id", call!.id);
    }
  });

  test("call_initiation_failure marks the call failed and logs an event", async () => {
    const convo = `convo-${stamp}-fail`;
    const { data: call } = await admin
      .from("calls")
      .insert({
        lead_id: leadId,
        campaign_id: campaignId,
        agent_id: agentId,
        twilio_number_id: twilioNumberId,
        direction: "outbound",
        status: "dialing",
        elevenlabs_conversation_id: convo,
      })
      .select("id")
      .single();
    try {
      const ctx = await playwrightRequest.newContext({
        baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
      });
      const res = await ctx.post("/api/elevenlabs/post-call", {
        headers: { "content-type": "application/json" },
        data: {
          type: "call_initiation_failure",
          data: { conversation_id: convo, failure_reason: "busy" },
        },
      });
      expect(res.ok()).toBe(true);
      expect(await res.json()).toEqual({ status: "applied" });

      const { data } = await admin
        .from("calls")
        .select("status, outcome")
        .eq("id", call!.id)
        .single();
      expect(data?.status).toBe("failed");
      expect(data?.outcome).toBe("failed");
      await ctx.dispose();
    } finally {
      await admin
        .from("system_events")
        .delete()
        .eq("kind", "call_initiation_failure")
        .eq("ref_id", call!.id);
      await admin
        .from("elevenlabs_webhook_events")
        .delete()
        .eq("conversation_id", convo);
      await admin.from("calls").delete().eq("id", call!.id);
    }
  });
});
