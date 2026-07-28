import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.describe.configure({ mode: "serial" });

/**
 * Double calling (docs/superpowers/specs/2026-07-27-double-call-design.md).
 *
 * Code review of this feature found six real defects, and every one was a
 * lifecycle bug no existing test would have caught. This spec is the
 * regression net for the three invariants those defects broke:
 *
 *   1. The pair advances the unified retry cycle exactly ONCE. Call 2 is
 *      flagged `is_redial` and must not advance it again — getting this
 *      wrong turned a 15-day cool-off into a 2-day one.
 *   2. `next_call_at` after call 2 must equal what call 1 set. Two separate
 *      unconditional writes in the dialer used to clobber it (a +30 min
 *      placeholder and a +5 min block bump), turning a 15-day cool-off into
 *      a ~30-minute redial loop.
 *   3. A stale marker must not mark a normally-due lead as a redial — that
 *      would wrongly suppress its cycle advance and stall the lead silently.
 *
 * Engine tests drive `applyRetryForCall` the same way tests/retry-engine.spec.ts
 * does: insert a `calls` row, then POST to the ElevenLabs post-call webhook.
 *
 * ended_at finding: the webhook itself unconditionally writes
 * `calls.ended_at = new Date().toISOString()` as part of its own row update
 * (src/lib/elevenlabs/post-call-webhook.ts, processTranscription) BEFORE it
 * runs the retry engine. So by the time applyRetryForCall reads ended_at for
 * its 120-second freshness guard, the row already carries a timestamp that's
 * milliseconds old — a freshly-webhooked call always passes the guard, and
 * seeded `calls` rows do NOT need to pre-set ended_at (mirrors
 * tests/retry-engine.spec.ts's seedCall, which never sets it either).
 *
 * Queue tests read the `dial_queue` view directly; claim tests call the
 * `claim_lead_for_dial` RPC directly. Both write next_call_at / redial_at
 * straight onto the lead instead of going through the engine, so the exact
 * window edges (fresh / stale / future-skewed) can be hit deterministically.
 *
 * Timestamps are compared by parsed value (Date.parse), never string
 * equality — Postgres returns a `+00:00` offset where JS emits `Z`.
 *
 * Like the other dialer specs (tests/dial-queue.spec.ts,
 * tests/shared-list-ownership.spec.ts), the queue tests assume a
 * weekday-daytime run: dial_queue's calling-hours check gates cold
 * (non-callback) leads to Mon-Fri regardless of the hour window, and the
 * seeded campaign here uses a full 00:00-23:59 window only to remove the
 * TIME-of-day dimension, per the other specs' documented convention.
 */
test.describe("Double calling", () => {
  const stamp = Date.now();
  const tail = String(stamp).slice(-6);

  let admin: SupabaseClient;
  let ownerId: string;
  let listId: string;
  let twilioNumberId: string;
  let agentId: string;
  let goalId: string;
  /** Opted in: double_call_enabled=true, wide-open calling hours + autopilot. */
  let campaignId: string;
  /** Opted out: double_call_enabled=false. Used only by the opt-out test. */
  let campaignOffId: string;

  async function seedLead(suffix: string, retryPosition = 0): Promise<string> {
    const { data: lead } = await admin
      .from("leads")
      .insert({
        owner_id: ownerId,
        list_id: listId,
        company: `E2E Double-Call Co ${stamp}-${suffix}`,
        business_phone: `+1555${tail}${suffix}`,
        status: "ready_to_call",
        retry_position: retryPosition,
        timezone: "America/New_York",
        line_type: "landline",
      })
      .select("id")
      .single();
    return lead!.id;
  }

  async function seedCall(
    conversationId: string,
    leadId: string,
    opts: { campaignId?: string; isRedial?: boolean } = {},
  ): Promise<string> {
    const { data: call } = await admin
      .from("calls")
      .insert({
        lead_id: leadId,
        campaign_id: opts.campaignId ?? campaignId,
        agent_id: agentId,
        twilio_number_id: twilioNumberId,
        direction: "outbound",
        status: "completed",
        elevenlabs_conversation_id: conversationId,
        is_redial: opts.isRedial ?? false,
      })
      .select("id")
      .single();
    return call!.id;
  }

  async function fireWebhook(
    conversationId: string,
    disposition: string,
    terminationReason?: string,
  ): Promise<void> {
    // Use Node's fetch so we don't need a Playwright `page` fixture.
    const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
    const res = await fetch(`${baseUrl}/api/elevenlabs/post-call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conversation_id: conversationId,
        analysis: { data_collection: { disposition } },
        ...(terminationReason
          ? { metadata: { termination_reason: terminationReason } }
          : {}),
      }),
    });
    expect(res.ok).toBe(true);
  }

  /** The dial_queue row for one lead, or null when it isn't surfaced. */
  async function queueRowFor(leadId: string) {
    const { data } = await admin
      .from("dial_queue")
      .select(
        "lead_id, campaign_id, is_redial_due, redial_number_id, next_call_at",
      )
      .eq("lead_id", leadId)
      .maybeSingle();
    return data;
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
      .insert({ owner_id: ownerId, name: `E2E Double-Call List ${stamp}` })
      .select("id")
      .single();
    listId = list!.id;

    const { data: num } = await admin
      .from("twilio_numbers")
      .insert({
        phone_number: `+1555${tail}99`,
        friendly_name: `E2E Double-Call Number ${stamp}`,
        country: "US",
        // dial_queue's pool gate requires a non-null elevenlabs_phone_number_id.
        elevenlabs_phone_number_id: `el-num-${stamp}`,
      })
      .select("id")
      .single();
    twilioNumberId = num!.id;

    const { data: agent } = await admin
      .from("agents")
      .insert({
        owner_id: ownerId,
        name: `E2E Double-Call Agent ${stamp}`,
        elevenlabs_agent_id: `e2e-double-call-${stamp}`,
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
      .insert({ owner_id: ownerId, name: `E2E Double-Call Goal ${stamp}` })
      .select("id")
      .single();
    goalId = goal!.id;

    const { data: campaign } = await admin
      .from("campaigns")
      .insert({
        owner_id: ownerId,
        name: `E2E Double-Call Campaign ${stamp}`,
        status: "active",
        agent_id: agentId,
        goal_id: goalId,
        twilio_number_id: twilioNumberId,
        double_call_enabled: true,
        autopilot_enabled: true,
        // Full-day window so the queue tests aren't time-of-day flaky.
        calling_hours_start: "00:00:00",
        calling_hours_end: "23:59:59",
      })
      .select("id")
      .single();
    campaignId = campaign!.id;

    const { data: campaignOff } = await admin
      .from("campaigns")
      .insert({
        owner_id: ownerId,
        name: `E2E Double-Call Campaign Off ${stamp}`,
        status: "active",
        agent_id: agentId,
        goal_id: goalId,
        twilio_number_id: twilioNumberId,
        double_call_enabled: false,
      })
      .select("id")
      .single();
    campaignOffId = campaignOff!.id;

    // Attach the Twilio number to the OPTED-IN campaign (pool gate + the
    // number applyRetryForCall reuses for the redial).
    await admin
      .from("twilio_numbers")
      .update({ attached_campaign_id: campaignId })
      .eq("id", twilioNumberId);

    // Attach the shared list to the OPTED-IN campaign so every lead created
    // via seedLead() is dial_queue-eligible under campaignId.
    await admin
      .from("list_campaign_attachments")
      .insert({ list_id: listId, campaign_id: campaignId });
  });

  test.afterAll(async () => {
    await admin
      .from("elevenlabs_webhook_events")
      .delete()
      .like("conversation_id", `dbl-${stamp}-%`);
    await admin
      .from("calls")
      .delete()
      .in("campaign_id", [campaignId, campaignOffId]);
    await admin
      .from("leads")
      .delete()
      .eq("list_id", listId ?? "");
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
      .in("id", [campaignId, campaignOffId]);
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

  // ---------------------------------------------------------------------
  // Engine: applyRetryForCall stamps (or correctly withholds) the marker.
  // ---------------------------------------------------------------------

  test("voicemail on an opted-in campaign at position 0 stamps the marker and advances the cycle", async () => {
    const leadId = await seedLead("01");
    const convo = `dbl-${stamp}-01`;
    await seedCall(convo, leadId);

    await fireWebhook(convo, "voicemail");

    const { data: lead } = await admin
      .from("leads")
      .select(
        "retry_position, redial_at, redial_number_id, next_call_at, status",
      )
      .eq("id", leadId)
      .single();
    expect(lead?.retry_position).toBe(1);
    expect(lead?.redial_at).not.toBeNull();
    expect(lead?.redial_number_id).toBe(twilioNumberId);
    expect(lead?.next_call_at).not.toBeNull();
    expect(lead?.status).toBe("ready_to_call");
  });

  test("voicemail on an opted-out campaign advances the cycle but stamps neither marker field", async () => {
    const leadId = await seedLead("02");
    const convo = `dbl-${stamp}-02`;
    await seedCall(convo, leadId, { campaignId: campaignOffId });

    await fireWebhook(convo, "voicemail");

    const { data: lead } = await admin
      .from("leads")
      .select("retry_position, redial_at, redial_number_id, next_call_at")
      .eq("id", leadId)
      .single();
    expect(lead?.retry_position).toBe(1);
    expect(lead?.redial_at).toBeNull();
    expect(lead?.redial_number_id).toBeNull();
    expect(lead?.next_call_at).not.toBeNull();
  });

  test("voicemail at retry position 1 advances the cycle without stamping a marker", async () => {
    const leadId = await seedLead("03", 1);
    const convo = `dbl-${stamp}-03`;
    await seedCall(convo, leadId);

    await fireWebhook(convo, "voicemail");

    const { data: lead } = await admin
      .from("leads")
      .select("retry_position, redial_at, redial_number_id")
      .eq("id", leadId)
      .single();
    expect(lead?.retry_position).toBe(2);
    expect(lead?.redial_at).toBeNull();
    expect(lead?.redial_number_id).toBeNull();
  });

  test("a non-voicemail outcome at position 0 advances the cycle without stamping a marker", async () => {
    const leadId = await seedLead("04");
    const convo = `dbl-${stamp}-04`;
    const callId = await seedCall(convo, leadId);

    // termination_reason drives telephonyOutcome() to a clean "no_answer" —
    // "no_answer" isn't a disposition the agent ever emits, so this is the
    // realistic way a non-voicemail retry outcome reaches the webhook.
    await fireWebhook(convo, "no_answer", "no-answer");

    const { data: call } = await admin
      .from("calls")
      .select("outcome")
      .eq("id", callId)
      .single();
    expect(call?.outcome).toBe("no_answer");

    const { data: lead } = await admin
      .from("leads")
      .select("retry_position, redial_at, redial_number_id")
      .eq("id", leadId)
      .single();
    expect(lead?.retry_position).toBe(1);
    expect(lead?.redial_at).toBeNull();
    expect(lead?.redial_number_id).toBeNull();
  });

  test("the pair advances the retry cycle exactly once", async () => {
    const leadId = await seedLead("05", 2);

    // Call 1: a real (non-redial) voicemail at the doubled position 2. Should
    // advance 2 -> 0 (the 15-day step) AND stamp the marker.
    const convo1 = `dbl-${stamp}-05a`;
    await seedCall(convo1, leadId);
    await fireWebhook(convo1, "voicemail");

    const { data: afterCall1 } = await admin
      .from("leads")
      .select(
        "retry_position, retry_counter, next_call_at, redial_at, redial_number_id",
      )
      .eq("id", leadId)
      .single();
    expect(afterCall1?.retry_position).toBe(0);
    expect(afterCall1?.redial_at).not.toBeNull();
    expect(afterCall1?.redial_number_id).toBe(twilioNumberId);

    // Call 2: the redial half of the pair, flagged is_redial. Must NOT
    // advance the cycle again and must NOT stamp a second marker.
    const convo2 = `dbl-${stamp}-05b`;
    await seedCall(convo2, leadId, { isRedial: true });
    await fireWebhook(convo2, "voicemail");

    const { data: afterCall2 } = await admin
      .from("leads")
      .select(
        "retry_position, retry_counter, next_call_at, redial_at, redial_number_id",
      )
      .eq("id", leadId)
      .single();
    // Cycle did not advance a second time.
    expect(afterCall2?.retry_position).toBe(0);
    expect(afterCall2?.retry_counter).toBe(afterCall1?.retry_counter);
    // next_call_at is exactly what call 1 set — not clobbered by call 2.
    expect(Date.parse(afterCall2!.next_call_at!)).toBe(
      Date.parse(afterCall1!.next_call_at!),
    );
    // No second redial was stamped — the marker from call 1 is untouched.
    expect(Date.parse(afterCall2!.redial_at!)).toBe(
      Date.parse(afterCall1!.redial_at!),
    );
    expect(afterCall2?.redial_number_id).toBe(twilioNumberId);
  });

  // ---------------------------------------------------------------------
  // Queue: dial_queue's redial branch and its is_redial_due ordering key.
  // ---------------------------------------------------------------------

  test("a lead due only via a fresh redial_at is surfaced as due, redial-flagged, with the right number", async () => {
    const leadId = await seedLead("06");
    const future = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    const fresh = new Date(Date.now() - 30 * 1000).toISOString();
    await admin
      .from("leads")
      .update({
        next_call_at: future,
        redial_at: fresh,
        redial_number_id: twilioNumberId,
      })
      .eq("id", leadId);

    const row = await queueRowFor(leadId);
    expect(row).not.toBeNull();
    expect(row?.is_redial_due).toBe(true);
    expect(row?.redial_number_id).toBe(twilioNumberId);
    expect(row?.campaign_id).toBe(campaignId);
  });

  test("a redial_at older than 10 minutes is not surfaced when next_call_at is still in the future", async () => {
    const leadId = await seedLead("07");
    const future = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    const stale = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    await admin
      .from("leads")
      .update({
        next_call_at: future,
        redial_at: stale,
        redial_number_id: twilioNumberId,
      })
      .eq("id", leadId);

    expect(await queueRowFor(leadId)).toBeNull();
  });

  test("a normally-due lead carrying a stale marker is surfaced but not flagged as a redial", async () => {
    const leadId = await seedLead("08");
    const due = new Date(Date.now() - 60 * 1000).toISOString();
    const stale = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    await admin
      .from("leads")
      .update({
        next_call_at: due,
        redial_at: stale,
        redial_number_id: twilioNumberId,
      })
      .eq("id", leadId);

    const row = await queueRowFor(leadId);
    expect(row).not.toBeNull();
    expect(row?.is_redial_due).toBe(false);
  });

  test("a future-stamped redial_at (clock skew) is not treated as due", async () => {
    const leadId = await seedLead("09");
    const future = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    const futureRedial = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    await admin
      .from("leads")
      .update({
        next_call_at: future,
        redial_at: futureRedial,
        redial_number_id: twilioNumberId,
      })
      .eq("id", leadId);

    expect(await queueRowFor(leadId)).toBeNull();
  });

  // ---------------------------------------------------------------------
  // Claim: claim_lead_for_dial's redial branch (must preserve, not lease).
  // ---------------------------------------------------------------------

  test("claiming a redial-due lead preserves next_call_at, clears both marker fields, and can't be claimed twice", async () => {
    const leadId = await seedLead("10");
    const future = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    const fresh = new Date(Date.now() - 30 * 1000).toISOString();
    await admin
      .from("leads")
      .update({
        next_call_at: future,
        redial_at: fresh,
        redial_number_id: twilioNumberId,
      })
      .eq("id", leadId);

    const { data: won } = await admin.rpc("claim_lead_for_dial", {
      in_lead_id: leadId,
      in_campaign_id: campaignId,
    });
    expect(won).toBe(true);

    const { data: lead } = await admin
      .from("leads")
      .select("next_call_at, redial_at, redial_number_id, owner_campaign_id")
      .eq("id", leadId)
      .single();
    // PRESERVED — no 2-minute lease stamped over call 1's real schedule.
    expect(Date.parse(lead!.next_call_at!)).toBe(Date.parse(future));
    expect(lead?.redial_at).toBeNull();
    expect(lead?.redial_number_id).toBeNull();
    expect(lead?.owner_campaign_id).toBe(campaignId);

    // The marker was consumed atomically — an immediate second claim finds
    // nothing to win (next_call_at is still future, redial_at is now null).
    const { data: wonAgain } = await admin.rpc("claim_lead_for_dial", {
      in_lead_id: leadId,
      in_campaign_id: campaignId,
    });
    expect(wonAgain).toBe(false);
  });

  test("a normal claim on a due lead still leases next_call_at ~2 minutes out", async () => {
    const leadId = await seedLead("11");
    const due = new Date(Date.now() - 60 * 1000).toISOString();
    await admin
      .from("leads")
      .update({ next_call_at: due, redial_at: null, redial_number_id: null })
      .eq("id", leadId);

    const { data: won } = await admin.rpc("claim_lead_for_dial", {
      in_lead_id: leadId,
      in_campaign_id: campaignId,
    });
    expect(won).toBe(true);

    const { data: lead } = await admin
      .from("leads")
      .select("next_call_at, redial_at, redial_number_id")
      .eq("id", leadId)
      .single();
    const leased = Date.parse(lead!.next_call_at!);
    const expected = Date.now() + 2 * 60 * 1000;
    expect(Math.abs(leased - expected)).toBeLessThan(60_000);
    expect(lead?.redial_at).toBeNull();
    expect(lead?.redial_number_id).toBeNull();
  });

  // ---------------------------------------------------------------------
  // Toggle: unticking "Double call on voicemail" must stop redials that are
  // already marked, not just future ones.
  //
  // The opt-in used to be read exactly once — by the retry engine, when call 1
  // ended. Nothing downstream re-checked it, so an operator who turned the
  // feature off kept getting second calls for up to another 10 minutes: one
  // per marker stamped before the switch flipped, which is precisely the
  // moment they were trying to stop. Both of these seed a live marker and then
  // flip the campaign, so a regression shows up as a redial surviving the
  // toggle rather than as a timing flake.
  //
  // These mutate the shared opted-in campaign, so each restores
  // double_call_enabled before finishing (the describe block is serial).
  // ---------------------------------------------------------------------

  async function setDoubleCall(enabled: boolean): Promise<void> {
    await admin
      .from("campaigns")
      .update({ double_call_enabled: enabled })
      .eq("id", campaignId);
  }

  test("turning the toggle off drops an already-marked redial from the queue, and back on restores it", async () => {
    const leadId = await seedLead("12");
    const future = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    const fresh = new Date(Date.now() - 30 * 1000).toISOString();
    await admin
      .from("leads")
      .update({
        next_call_at: future,
        redial_at: fresh,
        redial_number_id: twilioNumberId,
      })
      .eq("id", leadId);

    // Opted in: the marker is the only thing making this lead due.
    expect((await queueRowFor(leadId))?.is_redial_due).toBe(true);

    // Opted out: the same still-live marker no longer surfaces the lead at
    // all — next_call_at is two days out, so the redial branch was its only
    // way into the queue.
    await setDoubleCall(false);
    expect(await queueRowFor(leadId)).toBeNull();

    // The marker itself is untouched — turning the toggle off suppresses the
    // redial, it doesn't rewrite the lead. Re-ticking inside the window brings
    // it straight back.
    await setDoubleCall(true);
    expect((await queueRowFor(leadId))?.is_redial_due).toBe(true);
  });

  test("an already-marked redial cannot be claimed once the toggle is off", async () => {
    const leadId = await seedLead("13");
    const future = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    const fresh = new Date(Date.now() - 30 * 1000).toISOString();
    await admin
      .from("leads")
      .update({
        next_call_at: future,
        redial_at: fresh,
        redial_number_id: twilioNumberId,
      })
      .eq("id", leadId);

    await setDoubleCall(false);
    try {
      // next_call_at is still in the future, so with the opt-in gone there is
      // no branch left to win on.
      const { data: won } = await admin.rpc("claim_lead_for_dial", {
        in_lead_id: leadId,
        in_campaign_id: campaignId,
      });
      expect(won).toBe(false);

      // A lost claim must not have touched the row — in particular it must not
      // have consumed the marker or leased next_call_at.
      const { data: lead } = await admin
        .from("leads")
        .select("next_call_at, redial_at, redial_number_id")
        .eq("id", leadId)
        .single();
      expect(Date.parse(lead!.next_call_at!)).toBe(Date.parse(future));
      expect(Date.parse(lead!.redial_at!)).toBe(Date.parse(fresh));
      expect(lead?.redial_number_id).toBe(twilioNumberId);
    } finally {
      await setDoubleCall(true);
    }
  });
});
