import { test, expect, request as playwrightRequest } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.describe.configure({ mode: "serial" });

/**
 * Drives the ElevenLabs conversation-initiation client-data webhook:
 *  - Seed a campaign (with a transfer number), lead, and a `calls` row
 *    stamped with a known twilio_call_sid.
 *  - POST { call_sid } → assert the response is a
 *    conversation_initiation_client_data event whose dynamic_variables
 *    carry call_type, last_call_summary, and the campaign transfer number.
 *  - A pending callback flips call_type to "callback" and surfaces the
 *    originating call's pickup note as last_callback_notes — preferring the
 *    structured callback_notes, falling back to the raw summary for old rows.
 *  - An unknown call_sid still returns 200 with a complete blank set.
 *  - For INBOUND (keyed on called_number), the response carries a
 *    conversation_config_override.agent.first_message — the dialed number's
 *    campaign greeting, or the default when none is configured.
 */
test.describe("ElevenLabs conversation-init webhook", () => {
  const stamp = Date.now();
  const tail = String(stamp).slice(-6);
  const transferNumber = `+1555${tail}77`;

  let admin: SupabaseClient;
  let ownerId: string;
  let listId: string;
  let twilioNumberId: string;
  let campaignId: string;
  let agentId: string;
  let goalId: string;
  let leadId: string;

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
      .insert({ owner_id: ownerId, name: `E2E Init List ${stamp}` })
      .select("id")
      .single();
    listId = list!.id;

    const { data: num } = await admin
      .from("twilio_numbers")
      .insert({
        phone_number: `+1555${tail}66`,
        friendly_name: `E2E Init Number ${stamp}`,
        country: "US",
      })
      .select("id")
      .single();
    twilioNumberId = num!.id;

    const { data: agent } = await admin
      .from("agents")
      .insert({
        owner_id: ownerId,
        name: `E2E Init Agent ${stamp}`,
        elevenlabs_agent_id: `el-init-${stamp}`,
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
      .insert({ owner_id: ownerId, name: `E2E Init Goal ${stamp}` })
      .select("id")
      .single();
    goalId = goal!.id;

    const { data: campaign } = await admin
      .from("campaigns")
      .insert({
        owner_id: ownerId,
        name: `E2E Init Campaign ${stamp}`,
        status: "active",
        agent_id: agentId,
        goal_id: goalId,
        twilio_number_id: twilioNumberId,
        transfer_destination_phone: transferNumber,
      })
      .select("id")
      .single();
    campaignId = campaign!.id;

    const { data: lead } = await admin
      .from("leads")
      .insert({
        owner_id: ownerId,
        list_id: listId,
        company: `E2E Init Co ${stamp}`,
        business_phone: `+1555${tail}55`,
        status: "ready_to_call",
        owner_name: "Dana Owner",
        city: "Austin",
        category: "Fitness",
        google_rating: 4.6,
        google_reviews: 212,
      })
      .select("id")
      .single();
    leadId = lead!.id;

    // The rolling summary now lives per-campaign in lead_campaign_summaries
    // (leads.ai_summary was dropped 2026-07-02); buildVarsForCall reads it from
    // there, so seed it here for the "cold call surfaces the summary" assertion.
    await admin.from("lead_campaign_summaries").insert({
      lead_id: leadId,
      campaign_id: campaignId,
      ai_summary: "we know they run a busy gym / we last left off mid-pitch",
    });
  });

  test.afterAll(async () => {
    await admin
      .from("callbacks")
      .delete()
      .eq("lead_id", leadId ?? "");
    await admin
      .from("calls")
      .delete()
      .eq("lead_id", leadId ?? "");
    await admin
      .from("lead_campaign_summaries")
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

  test("resolves a cold call: summary + transfer number, call_type=cold", async ({
    baseURL,
  }) => {
    const sid = `CAinit${tail}cold`;
    const { data: call } = await admin
      .from("calls")
      .insert({
        lead_id: leadId,
        campaign_id: campaignId,
        agent_id: agentId,
        twilio_number_id: twilioNumberId,
        direction: "outbound",
        status: "in_progress",
        twilio_call_sid: sid,
      })
      .select("id")
      .single();
    try {
      const api = await playwrightRequest.newContext({ baseURL });
      const r = await api.post("/api/elevenlabs/conversation-init", {
        data: { call_sid: sid, agent_id: `el-init-${stamp}` },
      });
      expect(r.status()).toBe(200);
      const body = await r.json();
      expect(body.type).toBe("conversation_initiation_client_data");
      expect(body.dynamic_variables.call_type).toBe("cold");
      expect(body.dynamic_variables.last_call_summary).toContain("busy gym");
      expect(body.dynamic_variables.transfer_number).toBe(transferNumber);
      expect(body.dynamic_variables.last_callback_notes).toBe("");
      // Lead-context fields (numbers stringified).
      expect(body.dynamic_variables.owner_name).toBe("Dana Owner");
      expect(body.dynamic_variables.city).toBe("Austin");
      expect(body.dynamic_variables.category).toBe("Fitness");
      expect(body.dynamic_variables.google_rating).toBe("4.6");
      expect(body.dynamic_variables.google_reviews).toBe("212");
      await api.dispose();
    } finally {
      await admin.from("calls").delete().eq("id", call!.id);
    }
  });

  test("a pending callback flips call_type and surfaces the prior summary", async ({
    baseURL,
  }) => {
    // Originating call (the one that produced the callback) + its summary.
    const { data: origCall } = await admin
      .from("calls")
      .insert({
        lead_id: leadId,
        campaign_id: campaignId,
        agent_id: agentId,
        twilio_number_id: twilioNumberId,
        direction: "outbound",
        status: "completed",
        outcome: "callback",
        summary: "Asked us to call back Tuesday about after-hours coverage.",
      })
      .select("id")
      .single();
    await admin.from("callbacks").insert({
      lead_id: leadId,
      campaign_id: campaignId,
      originating_call_id: origCall!.id,
      scheduled_at: new Date().toISOString(),
      status: "pending",
    });

    const sid = `CAinit${tail}cb`;
    const { data: call } = await admin
      .from("calls")
      .insert({
        lead_id: leadId,
        campaign_id: campaignId,
        agent_id: agentId,
        twilio_number_id: twilioNumberId,
        direction: "outbound",
        status: "in_progress",
        twilio_call_sid: sid,
      })
      .select("id")
      .single();
    try {
      const api = await playwrightRequest.newContext({ baseURL });
      const r = await api.post("/api/elevenlabs/conversation-init", {
        data: { call_sid: sid },
      });
      expect(r.status()).toBe(200);
      const body = await r.json();
      expect(body.dynamic_variables.call_type).toBe("callback");
      expect(body.dynamic_variables.last_callback_notes).toContain(
        "call back Tuesday",
      );
      await api.dispose();
    } finally {
      await admin.from("callbacks").delete().eq("lead_id", leadId);
      await admin.from("calls").delete().eq("id", call!.id);
      await admin.from("calls").delete().eq("id", origCall!.id);
    }
  });

  test("a pending callback prefers the originating call's callback_notes over its raw summary", async ({
    baseURL,
  }) => {
    // The originating call now carries a structured pickup note — the agent
    // should get THAT, not the raw ElevenLabs recap.
    const { data: origCall } = await admin
      .from("calls")
      .insert({
        lead_id: leadId,
        campaign_id: campaignId,
        agent_id: agentId,
        twilio_number_id: twilioNumberId,
        direction: "outbound",
        status: "completed",
        outcome: "callback",
        summary: "Raw recap that must not be surfaced.",
        callback_notes:
          "Agreed: call back Wednesday 9am to reach owner Dana. Don't re-ask their scheduling software.",
      })
      .select("id")
      .single();
    await admin.from("callbacks").insert({
      lead_id: leadId,
      campaign_id: campaignId,
      originating_call_id: origCall!.id,
      scheduled_at: new Date().toISOString(),
      status: "pending",
    });

    const sid = `CAinit${tail}cb2`;
    const { data: call } = await admin
      .from("calls")
      .insert({
        lead_id: leadId,
        campaign_id: campaignId,
        agent_id: agentId,
        twilio_number_id: twilioNumberId,
        direction: "outbound",
        status: "in_progress",
        twilio_call_sid: sid,
      })
      .select("id")
      .single();
    try {
      const api = await playwrightRequest.newContext({ baseURL });
      const r = await api.post("/api/elevenlabs/conversation-init", {
        data: { call_sid: sid },
      });
      expect(r.status()).toBe(200);
      const body = await r.json();
      expect(body.dynamic_variables.last_callback_notes).toContain(
        "call back Wednesday",
      );
      expect(body.dynamic_variables.last_callback_notes).not.toContain(
        "must not be surfaced",
      );
      await api.dispose();
    } finally {
      await admin.from("callbacks").delete().eq("lead_id", leadId);
      await admin.from("calls").delete().eq("id", call!.id);
      await admin.from("calls").delete().eq("id", origCall!.id);
    }
  });

  test("an unknown call_sid returns 200 with a complete blank set", async ({
    baseURL,
  }) => {
    const api = await playwrightRequest.newContext({ baseURL });
    const r = await api.post("/api/elevenlabs/conversation-init", {
      data: { call_sid: "CA_does_not_exist" },
    });
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.type).toBe("conversation_initiation_client_data");
    expect(body.dynamic_variables.call_type).toBe("cold");
    expect(body.dynamic_variables.last_call_summary).toBe("");
    expect(body.dynamic_variables.transfer_number).toBe("");
    expect(body.dynamic_variables.owner_name).toBe("");
    expect(body.dynamic_variables.google_rating).toBe("");
    await api.dispose();
  });

  test("inbound: returns the campaign greeting as a first_message override", async ({
    baseURL,
  }) => {
    const greeting = `Thanks for calling E2E ${stamp}! How can I help?`;
    await admin
      .from("campaigns")
      .update({ inbound_greeting: greeting })
      .eq("id", campaignId);
    try {
      const api = await playwrightRequest.newContext({ baseURL });
      const r = await api.post("/api/elevenlabs/conversation-init", {
        data: { called_number: `+1555${tail}66` },
      });
      expect(r.status()).toBe(200);
      const body = await r.json();
      expect(body.conversation_config_override.agent.first_message).toBe(
        greeting,
      );
      await api.dispose();
    } finally {
      await admin
        .from("campaigns")
        .update({ inbound_greeting: null })
        .eq("id", campaignId);
    }
  });

  test("inbound: an unconfigured number falls back to the default greeting", async ({
    baseURL,
  }) => {
    const api = await playwrightRequest.newContext({ baseURL });
    const r = await api.post("/api/elevenlabs/conversation-init", {
      data: { called_number: "+19998887777" },
    });
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.conversation_config_override.agent.first_message).toBe(
      "Hi, thanks for calling! How can I help you today?",
    );
    await api.dispose();
  });
});
