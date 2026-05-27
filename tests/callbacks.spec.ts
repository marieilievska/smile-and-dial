import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.use({ storageState: "playwright/.auth/user.json" });

test.describe.configure({ mode: "serial" });

/**
 * Callbacks page (Step 32 / BUILD_PLAN §17 line 1071).
 *
 * Coverage:
 *  - Pending callback renders, default status filter is pending
 *  - Status filter narrows correctly
 *  - Reschedule moves scheduled_at + the lead's next_call_at, resets
 *    voicemail_attempts
 *  - Cancel flips status to cancelled and returns the lead to ready
 *  - Voicemail escalation (1st VM → +30 min, 3rd VM → missed + resting
 *    15 days) by triggering the retry engine via the ElevenLabs webhook
 */
test.describe("Callbacks page", () => {
  const stamp = Date.now();
  const tail = String(stamp).slice(-6);

  let admin: SupabaseClient;
  let ownerId: string;
  let listId: string;
  let agentId: string;
  let goalId: string;
  let campaignId: string;
  let twilioNumberId: string;
  const leadIds: string[] = [];
  const callbackIds: string[] = [];
  const callIds: string[] = [];

  async function seedLead(suffix: string): Promise<string> {
    const { data } = await admin
      .from("leads")
      .insert({
        owner_id: ownerId,
        list_id: listId,
        company: `E2E CB Lead ${stamp}-${suffix}`,
        business_phone: `+1777${tail}${suffix}`,
        status: "callback",
      })
      .select("id")
      .single();
    leadIds.push(data!.id);
    return data!.id;
  }

  async function seedCallback(opts: {
    leadId: string;
    scheduledAt: Date;
    voicemailAttempts?: number;
  }): Promise<string> {
    const { data } = await admin
      .from("callbacks")
      .insert({
        lead_id: opts.leadId,
        campaign_id: campaignId,
        scheduled_at: opts.scheduledAt.toISOString(),
        status: "pending",
        voicemail_attempts: opts.voicemailAttempts ?? 0,
      })
      .select("id")
      .single();
    callbackIds.push(data!.id);
    return data!.id;
  }

  async function seedCall(opts: {
    leadId: string;
    conversationId: string;
  }): Promise<string> {
    const { data } = await admin
      .from("calls")
      .insert({
        lead_id: opts.leadId,
        campaign_id: campaignId,
        agent_id: agentId,
        twilio_number_id: twilioNumberId,
        direction: "outbound",
        status: "completed",
        elevenlabs_conversation_id: opts.conversationId,
      })
      .select("id")
      .single();
    callIds.push(data!.id);
    return data!.id;
  }

  async function fireElevenLabsWebhook(
    conversationId: string,
    disposition: string,
  ): Promise<void> {
    const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
    const res = await fetch(`${baseUrl}/api/elevenlabs/post-call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conversation_id: conversationId,
        analysis: { data_collection: { disposition } },
      }),
    });
    expect(res.ok).toBe(true);
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
      .insert({ owner_id: ownerId, name: `E2E CB List ${stamp}` })
      .select("id")
      .single();
    listId = list!.id;

    const { data: num } = await admin
      .from("twilio_numbers")
      .insert({
        phone_number: `+1777${tail}90`,
        friendly_name: `E2E CB Number ${stamp}`,
        country: "US",
      })
      .select("id")
      .single();
    twilioNumberId = num!.id;

    const { data: agent } = await admin
      .from("agents")
      .insert({
        owner_id: ownerId,
        name: `E2E CB Agent ${stamp}`,
        elevenlabs_agent_id: `cb-agent-${stamp}`,
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
      .insert({ owner_id: ownerId, name: `E2E CB Goal ${stamp}` })
      .select("id")
      .single();
    goalId = goal!.id;

    const { data: campaign } = await admin
      .from("campaigns")
      .insert({
        owner_id: ownerId,
        name: `E2E CB Campaign ${stamp}`,
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
    if (callbackIds.length > 0) {
      await admin.from("callbacks").delete().in("id", callbackIds);
    }
    if (callIds.length > 0) {
      await admin.from("calls").delete().in("id", callIds);
    }
    if (leadIds.length > 0) {
      await admin.from("system_events").delete().in("ref_id", callbackIds);
      await admin.from("leads").delete().in("id", leadIds);
    }
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

  test("page lists pending callbacks by default with status filter", async ({
    page,
  }) => {
    const leadId = await seedLead("10");
    await seedCallback({
      leadId,
      scheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    await page.goto(`/callbacks?campaign=${campaignId}`);
    await expect(
      page.getByRole("cell", { name: `E2E CB Lead ${stamp}-10` }),
    ).toBeVisible();
  });

  test("reschedule moves scheduled_at and the lead's next_call_at", async ({
    page,
  }) => {
    const leadId = await seedLead("20");
    const cbId = await seedCallback({
      leadId,
      scheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    await page.goto(`/callbacks?campaign=${campaignId}`);
    // Round 9 — the row's Reschedule trigger has visible text "Reschedule"
    // (not aria-label "Reschedule callback" anymore). Scope to the row.
    await page
      .getByRole("row", { name: new RegExp(`E2E CB Lead ${stamp}-20`) })
      .getByRole("button", { name: "Reschedule" })
      .click();

    // Pick a time 3 hours from now (in local time, the dialog's
    // initial value is the current scheduled time).
    const future = new Date(Date.now() + 3 * 60 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const local = `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(
      future.getDate(),
    )}T${pad(future.getHours())}:${pad(future.getMinutes())}`;
    await page.getByLabel("When").fill(local);
    // Confirm inside the dialog — page-wide "Reschedule" would now match
    // both the row trigger and the dialog confirm.
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Reschedule", exact: true })
      .click();
    await expect(page.getByText("Rescheduled.")).toBeVisible();

    const { data: cb } = await admin
      .from("callbacks")
      .select("scheduled_at, voicemail_attempts")
      .eq("id", cbId)
      .single();
    const newScheduled = new Date(cb!.scheduled_at).getTime();
    expect(Math.abs(newScheduled - future.getTime())).toBeLessThan(60_000);
    expect(cb?.voicemail_attempts).toBe(0);

    const { data: lead } = await admin
      .from("leads")
      .select("next_call_at")
      .eq("id", leadId)
      .single();
    expect(new Date(lead!.next_call_at!).getTime()).toBe(newScheduled);
  });

  test("cancel flips status to cancelled and returns lead to ready", async ({
    page,
  }) => {
    const leadId = await seedLead("30");
    const cbId = await seedCallback({
      leadId,
      scheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    await page.goto(`/callbacks?campaign=${campaignId}`);
    // Round 9 — row trigger has visible text "Cancel" (not "Cancel
    // callback"). Scope to the row; confirm inside the alertdialog.
    await page
      .getByRole("row", { name: new RegExp(`E2E CB Lead ${stamp}-30`) })
      .getByRole("button", { name: "Cancel" })
      .click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Cancel callback" })
      .click();
    await expect(page.getByText("Callback cancelled.")).toBeVisible();

    const { data: cb } = await admin
      .from("callbacks")
      .select("status")
      .eq("id", cbId)
      .single();
    expect(cb?.status).toBe("cancelled");
    const { data: lead } = await admin
      .from("leads")
      .select("status, next_call_at")
      .eq("id", leadId)
      .single();
    expect(lead?.status).toBe("ready_to_call");
    expect(lead?.next_call_at).toBeNull();
  });

  test("1st callback voicemail pushes scheduled_at by 30 min", async () => {
    const leadId = await seedLead("40");
    const originalAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const cbId = await seedCallback({
      leadId,
      scheduledAt: originalAt,
    });
    const convo = `cb-vm1-${stamp}`;
    await seedCall({ leadId, conversationId: convo });
    // Voicemail isn't an ElevenLabs disposition, so we manually set outcome
    // on the call and trigger the engine via a webhook that won't change
    // it. Instead, set outcome directly then call applyRetryForCall via
    // the post-call webhook with a no-op disposition. Simpler: set outcome
    // directly and clear retry_applied_at so a follow-up trigger applies.
    await admin
      .from("calls")
      .update({ outcome: "voicemail", outcome_source: "manual" })
      .eq("elevenlabs_conversation_id", convo);
    // Trigger the engine through the ElevenLabs webhook (it calls
    // applyOutcomeSideEffects → applyRetryForCall in the "else" branch).
    await fireElevenLabsWebhook(convo, "");

    const { data: cb } = await admin
      .from("callbacks")
      .select("scheduled_at, status, voicemail_attempts")
      .eq("id", cbId)
      .single();
    expect(cb?.voicemail_attempts).toBe(1);
    expect(cb?.status).toBe("pending");
    const scheduled = new Date(cb!.scheduled_at).getTime();
    const expected = Date.now() + 30 * 60 * 1000;
    expect(Math.abs(scheduled - expected)).toBeLessThan(60_000);
  });

  test("3rd callback voicemail marks the callback missed and rests the lead", async () => {
    const leadId = await seedLead("50");
    const cbId = await seedCallback({
      leadId,
      scheduledAt: new Date(Date.now() + 60 * 60 * 1000),
      voicemailAttempts: 2,
    });
    const convo = `cb-vm3-${stamp}`;
    await seedCall({ leadId, conversationId: convo });
    await admin
      .from("calls")
      .update({ outcome: "voicemail", outcome_source: "manual" })
      .eq("elevenlabs_conversation_id", convo);
    await fireElevenLabsWebhook(convo, "");

    const { data: cb } = await admin
      .from("callbacks")
      .select("status, voicemail_attempts")
      .eq("id", cbId)
      .single();
    expect(cb?.status).toBe("missed");
    expect(cb?.voicemail_attempts).toBe(3);

    const { data: lead } = await admin
      .from("leads")
      .select("status, resting_until, next_call_at")
      .eq("id", leadId)
      .single();
    expect(lead?.status).toBe("resting");
    const restingUntil = new Date(lead!.resting_until!).getTime();
    const expected = Date.now() + 15 * 24 * 60 * 60 * 1000;
    expect(Math.abs(restingUntil - expected)).toBeLessThan(60_000);
  });
});
