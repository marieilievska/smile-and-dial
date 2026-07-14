import { test, expect, request as playwrightRequest } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.describe.configure({ mode: "serial" });

/**
 * Twilio inbound voice webhook (Step 29 / BUILD_PLAN §6).
 *
 *   1. Inbound to a Twilio number we don't own → "not in service" TwiML
 *   2. Inbound to an attached number with a matching lead → reuses the
 *      lead, preserves ai_summary
 *   3. Inbound to an attached number with no matching lead → creates a
 *      new lead in the owner's auto-managed Inbound list
 *   4. Replay (same CallSid) → idempotent (unique constraint)
 */
test.describe("Twilio inbound routing", () => {
  const stamp = Date.now();
  const tail = String(stamp).slice(-6);
  const ourNumber = `+1333${tail}11`;
  const someoneElsesNumber = `+1333${tail}99`;
  const knownCaller = `+1888${tail}22`;
  const unknownCaller = `+1888${tail}33`;

  let admin: SupabaseClient;
  let ownerId: string;
  let listId: string;
  let twilioNumberId: string;
  let campaignId: string;
  let agentId: string;
  let goalId: string;
  let knownLeadId: string;
  const callSids: string[] = [];

  async function post(callSid: string, from: string, to: string) {
    const context = await playwrightRequest.newContext({
      baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
      storageState: undefined,
    });
    const form = new URLSearchParams({
      CallSid: callSid,
      From: from,
      To: to,
      AccountSid: "ACtest",
    });
    const res = await context.post("/api/twilio/voice-inbound", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      data: form.toString(),
    });
    const body = await res.text();
    await context.dispose();
    return { res, body };
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
      .insert({ owner_id: ownerId, name: `E2E Inbound List ${stamp}` })
      .select("id")
      .single();
    listId = list!.id;

    const { data: num } = await admin
      .from("twilio_numbers")
      .insert({
        phone_number: ourNumber,
        friendly_name: `E2E Inbound Number ${stamp}`,
        country: "US",
      })
      .select("id")
      .single();
    twilioNumberId = num!.id;

    const { data: agent } = await admin
      .from("agents")
      .insert({
        owner_id: ownerId,
        name: `E2E Inbound Agent ${stamp}`,
        elevenlabs_agent_id: `inbound-agent-${stamp}`,
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
      .insert({ owner_id: ownerId, name: `E2E Inbound Goal ${stamp}` })
      .select("id")
      .single();
    goalId = goal!.id;

    const { data: campaign } = await admin
      .from("campaigns")
      .insert({
        owner_id: ownerId,
        name: `E2E Inbound Campaign ${stamp}`,
        status: "active",
        agent_id: agentId,
        goal_id: goalId,
        twilio_number_id: twilioNumberId,
      })
      .select("id")
      .single();
    campaignId = campaign!.id;
    // Denormalized pointer the inbound webhook looks at.
    await admin
      .from("twilio_numbers")
      .update({ attached_campaign_id: campaignId })
      .eq("id", twilioNumberId);

    // Pre-existing lead for the "known caller" case.
    const { data: kLead } = await admin
      .from("leads")
      .insert({
        owner_id: ownerId,
        list_id: listId,
        company: `Known Inbound Co ${stamp}`,
        business_phone: knownCaller,
        ai_summary: "Talked twice already; interested in pricing.",
      })
      .select("id")
      .single();
    knownLeadId = kLead!.id;
  });

  test.afterAll(async () => {
    if (callSids.length > 0) {
      await admin.from("calls").delete().in("twilio_call_sid", callSids);
    }
    // Auto-created inbound leads land in the owner's inbound list.
    await admin
      .from("leads")
      .delete()
      .eq("owner_id", ownerId)
      .like("business_phone", `+1888${tail}%`);
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
    // Tidy the auto-created Inbound list if we created it.
    await admin
      .from("lists")
      .delete()
      .eq("owner_id", ownerId)
      .eq("is_inbound_default", true);
  });

  test("inbound to an unowned number returns the not-in-service TwiML", async () => {
    const sid = `CAinbound-${stamp}-unowned`;
    callSids.push(sid);
    const { res, body } = await post(sid, knownCaller, someoneElsesNumber);
    expect(res.ok()).toBe(true);
    expect(res.headers()["content-type"]).toContain("text/xml");
    expect(body).toContain("not in service");
    // No call row was created.
    const { data: c } = await admin
      .from("calls")
      .select("id")
      .eq("twilio_call_sid", sid)
      .maybeSingle();
    expect(c).toBeNull();
  });

  test("inbound from a known caller reuses the lead and preserves ai_summary", async () => {
    const sid = `CAinbound-${stamp}-known`;
    callSids.push(sid);
    const { res, body } = await post(sid, knownCaller, ourNumber);
    expect(res.ok()).toBe(true);
    expect(body).toContain("Connecting you to agent");
    expect(body).toContain("Previous summary");
    expect(body).toContain("Talked twice already");

    const { data: call } = await admin
      .from("calls")
      .select("lead_id, direction, status, agent_id, twilio_number_id")
      .eq("twilio_call_sid", sid)
      .single();
    expect(call?.lead_id).toBe(knownLeadId);
    expect(call?.direction).toBe("inbound");
    expect(call?.status).toBe("in_progress");
    expect(call?.agent_id).toBe(agentId);
    expect(call?.twilio_number_id).toBe(twilioNumberId);
  });

  test("inbound from an unknown caller creates a lead in the Inbound list", async () => {
    const sid = `CAinbound-${stamp}-unknown`;
    callSids.push(sid);
    const { res, body } = await post(sid, unknownCaller, ourNumber);
    expect(res.ok()).toBe(true);
    expect(body).toContain("No prior summary on file");

    const { data: call } = await admin
      .from("calls")
      .select("lead_id, direction")
      .eq("twilio_call_sid", sid)
      .single();
    expect(call?.direction).toBe("inbound");

    const { data: lead } = await admin
      .from("leads")
      .select("business_phone, list_id")
      .eq("id", call!.lead_id)
      .single();
    expect(lead?.business_phone).toBe(unknownCaller);
    const { data: list } = await admin
      .from("lists")
      .select("name, is_inbound_default")
      .eq("id", lead!.list_id!)
      .single();
    expect(list?.name).toBe("Inbound");
    expect(list?.is_inbound_default).toBe(true);
  });

  test("a replayed inbound webhook is idempotent on CallSid", async () => {
    const sid = `CAinbound-${stamp}-replay`;
    callSids.push(sid);

    const first = await post(sid, unknownCaller, ourNumber);
    expect(first.res.ok()).toBe(true);
    const { data: firstCalls } = await admin
      .from("calls")
      .select("id")
      .eq("twilio_call_sid", sid);
    expect(firstCalls?.length).toBe(1);

    // Replay → still one call row, same id.
    const second = await post(sid, unknownCaller, ourNumber);
    expect(second.res.ok()).toBe(true);
    const { data: secondCalls } = await admin
      .from("calls")
      .select("id")
      .eq("twilio_call_sid", sid);
    expect(secondCalls?.length).toBe(1);
    expect(secondCalls![0].id).toBe(firstCalls![0].id);
  });
});
