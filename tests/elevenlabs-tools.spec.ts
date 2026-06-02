import { test, expect, request as playwrightRequest } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.describe.configure({ mode: "serial" });

/**
 * Drives the ElevenLabs custom server-tool webhooks end-to-end:
 *  - Seed a campaign + lead + call so a tool can resolve identity via call_id.
 *  - POST each tool's payload to /api/elevenlabs/tools/<tool> exactly as
 *    ElevenLabs would (flat JSON body carrying call_id), assert the side
 *    effect (DNC row, callback row, captured email, audit event) and the
 *    JSON result shape the LLM gets back.
 *  - Unknown tool → 400; unresolved call_id → graceful success:false.
 *
 * Runs in mock mode (ELEVENLABS_LIVE != "live"), so the shared secret is not
 * required and no network calls leave the box.
 */
test.describe("ElevenLabs server-tool webhooks", () => {
  const stamp = Date.now();

  let admin: SupabaseClient;
  let ownerId: string;
  let listId: string;
  let twilioNumberId: string;
  let campaignId: string;
  let agentId: string;
  let goalId: string;

  function baseURL() {
    return process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
  }

  async function post(tool: string, data: Record<string, unknown>) {
    const ctx = await playwrightRequest.newContext({
      baseURL: baseURL(),
      storageState: undefined,
    });
    const res = await ctx.post(`/api/elevenlabs/tools/${tool}`, {
      headers: { "content-type": "application/json" },
      data,
    });
    const body = await res.json().catch(() => null);
    await ctx.dispose();
    return { status: res.status(), body };
  }

  /** Seed a fresh lead + call and return both ids. */
  async function seedLeadAndCall(opts?: {
    businessEmail?: string | null;
    phone?: string;
  }) {
    const { data: lead } = await admin
      .from("leads")
      .insert({
        owner_id: ownerId,
        list_id: listId,
        company: `E2E Tools Co ${stamp}`,
        business_phone: opts?.phone ?? `+1555${String(Date.now()).slice(-6)}00`,
        business_email: opts?.businessEmail ?? null,
        owner_name: "Pat Owner",
      })
      .select("id")
      .single();
    const { data: call } = await admin
      .from("calls")
      .insert({
        lead_id: lead!.id,
        campaign_id: campaignId,
        agent_id: agentId,
        twilio_number_id: twilioNumberId,
        direction: "outbound",
        status: "in_progress",
      })
      .select("id")
      .single();
    return { leadId: lead!.id as string, callId: call!.id as string };
  }

  async function cleanupLeadAndCall(leadId: string, callId: string) {
    await admin.from("system_events").delete().eq("ref_id", callId);
    await admin.from("callbacks").delete().eq("lead_id", leadId);
    await admin.from("dnc_entries").delete().eq("source_call_id", callId);
    await admin.from("calls").delete().eq("id", callId);
    await admin.from("leads").delete().eq("id", leadId);
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
      .insert({ owner_id: ownerId, name: `E2E Tools List ${stamp}` })
      .select("id")
      .single();
    listId = list!.id;

    const { data: num } = await admin
      .from("twilio_numbers")
      .insert({
        phone_number: `+1555${String(stamp).slice(-6)}40`,
        friendly_name: `E2E Tools Number ${stamp}`,
        country: "US",
      })
      .select("id")
      .single();
    twilioNumberId = num!.id;

    const { data: agent } = await admin
      .from("agents")
      .insert({
        owner_id: ownerId,
        name: `E2E Tools Agent ${stamp}`,
        elevenlabs_agent_id: `el-tools-agent-${stamp}`,
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
      .insert({ owner_id: ownerId, name: `E2E Tools Goal ${stamp}` })
      .select("id")
      .single();
    goalId = goal!.id;

    const { data: campaign } = await admin
      .from("campaigns")
      .insert({
        owner_id: ownerId,
        name: `E2E Tools Campaign ${stamp}`,
        status: "active",
        agent_id: agentId,
        goal_id: goalId,
        twilio_number_id: twilioNumberId,
      })
      .select("id")
      .single();
    campaignId = campaign!.id;
  });

  test.afterAll(async () => {
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

  test("an unknown tool name returns 400", async () => {
    const { status } = await post("not_a_real_tool", { call_id: "x" });
    expect(status).toBe(400);
  });

  test("an unresolved call_id fails gracefully (200, success:false)", async () => {
    const { status, body } = await post("mark_dnc", {
      call_id: "00000000-0000-0000-0000-000000000000",
    });
    expect(status).toBe(200);
    expect(body.success).toBe(false);
    expect(typeof body.message).toBe("string");
  });

  test("mark_dnc adds the lead's phone and sets status to dnc", async () => {
    const phone = `+1555${String(Date.now()).slice(-6)}01`;
    const { leadId, callId } = await seedLeadAndCall({ phone });
    try {
      const { status, body } = await post("mark_dnc", { call_id: callId });
      expect(status).toBe(200);
      expect(body.success).toBe(true);

      const { data: dnc } = await admin
        .from("dnc_entries")
        .select("reason, source_call_id, company_snapshot")
        .eq("phone", phone)
        .single();
      expect(dnc?.reason).toBe("dnc_requested");
      expect(dnc?.source_call_id).toBe(callId);

      const { data: lead } = await admin
        .from("leads")
        .select("status, next_call_at")
        .eq("id", leadId)
        .single();
      expect(lead?.status).toBe("dnc");
      expect(lead?.next_call_at).toBeNull();
    } finally {
      await admin.from("dnc_entries").delete().eq("phone", phone);
      await cleanupLeadAndCall(leadId, callId);
    }
  });

  test("schedule_callback creates a pending callback and queues the lead", async () => {
    const { leadId, callId } = await seedLeadAndCall();
    const when = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    try {
      const { status, body } = await post("schedule_callback", {
        call_id: callId,
        callback_datetime: when,
      });
      expect(status).toBe(200);
      expect(body.success).toBe(true);

      const { data: cb } = await admin
        .from("callbacks")
        .select("status, scheduled_at, originating_call_id, created_by")
        .eq("lead_id", leadId)
        .single();
      expect(cb?.status).toBe("pending");
      expect(cb?.originating_call_id).toBe(callId);
      expect(cb?.created_by).toBeNull();
      expect(new Date(cb!.scheduled_at).toISOString()).toBe(when);

      const { data: lead } = await admin
        .from("leads")
        .select("status, next_call_at")
        .eq("id", leadId)
        .single();
      expect(lead?.status).toBe("callback");
      expect(lead?.next_call_at).not.toBeNull();
    } finally {
      await cleanupLeadAndCall(leadId, callId);
    }
  });

  test("schedule_callback rejects a past time", async () => {
    const { leadId, callId } = await seedLeadAndCall();
    try {
      const { body } = await post("schedule_callback", {
        call_id: callId,
        callback_datetime: "2020-01-01T10:00:00-05:00",
      });
      expect(body.success).toBe(false);
      const { data: cb } = await admin
        .from("callbacks")
        .select("id")
        .eq("lead_id", leadId);
      expect(cb?.length).toBe(0);
    } finally {
      await cleanupLeadAndCall(leadId, callId);
    }
  });

  test("send_email captures a confirmed email onto a lead that had none", async () => {
    const { leadId, callId } = await seedLeadAndCall({ businessEmail: null });
    const email = `tool-${stamp}@example.com`;
    try {
      const { status, body } = await post("send_email", {
        call_id: callId,
        email,
        note: "Pricing sheet",
      });
      expect(status).toBe(200);
      expect(body.success).toBe(true);

      const { data: lead } = await admin
        .from("leads")
        .select("business_email")
        .eq("id", leadId)
        .single();
      expect(lead?.business_email).toBe(email);

      const { data: ev } = await admin
        .from("system_events")
        .select("kind")
        .eq("ref_id", callId)
        .eq("kind", "tool_send_email")
        .single();
      expect(ev?.kind).toBe("tool_send_email");
    } finally {
      await cleanupLeadAndCall(leadId, callId);
    }
  });

  test("get_available_times returns slots without needing a resolved call", async () => {
    const { status, body } = await post("get_available_times", {
      call_id: "anything",
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.slots)).toBe(true);
    expect(body.slots.length).toBe(3);
    expect(typeof body.slots[0].slot_id).toBe("string");
    expect(typeof body.slots[0].label).toBe("string");
  });

  test("book_appointment confirms and logs the booking", async () => {
    const { leadId, callId } = await seedLeadAndCall();
    const slotId = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    try {
      const { status, body } = await post("book_appointment", {
        call_id: callId,
        slot_id: slotId,
        email: `book-${stamp}@example.com`,
      });
      expect(status).toBe(200);
      expect(body.success).toBe(true);

      const { data: ev } = await admin
        .from("system_events")
        .select("kind")
        .eq("ref_id", callId)
        .eq("kind", "tool_book_appointment")
        .single();
      expect(ev?.kind).toBe("tool_book_appointment");
    } finally {
      await cleanupLeadAndCall(leadId, callId);
    }
  });
});
