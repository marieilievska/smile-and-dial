import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.describe.configure({ mode: "serial" });

/**
 * BUILD_PLAN §17 line 853-854: a Twilio number with a connect rate below
 * 15% over 300+ outbound calls today gets flagged for rotation, and all
 * admins get a notification. last_* columns update on every run so the
 * Settings page can surface current numbers.
 */
test.describe("Connect rate monitor", () => {
  const stamp = Date.now();

  let admin: SupabaseClient;
  let ownerId: string;
  let listId: string;
  let leadId: string;
  let agentId: string;
  let goalId: string;
  let campaignId: string;
  const twilioNumberIds: string[] = [];

  async function seedNumber(label: string): Promise<string> {
    const { data } = await admin
      .from("twilio_numbers")
      .insert({
        // Use the random salt to keep phone unique even when several
        // numbers are seeded in the same test run.
        phone_number: `+1555${Math.floor(Math.random() * 1e7)
          .toString()
          .padStart(7, "0")}`,
        friendly_name: `E2E Connect-Rate ${label} ${stamp}`,
        country: "US",
      })
      .select("id")
      .single();
    twilioNumberIds.push(data!.id);
    return data!.id;
  }

  /**
   * Bulk-insert N call rows alternating between connected/non-connected
   * outcomes by `ratio`. Returns nothing — caller asserts on the row by
   * running the monitor.
   */
  async function seedCalls(opts: {
    numberId: string;
    total: number;
    connectedRatio: number;
  }): Promise<void> {
    const rows: Record<string, unknown>[] = [];
    const connected = Math.round(opts.total * opts.connectedRatio);
    for (let i = 0; i < opts.total; i++) {
      rows.push({
        lead_id: leadId,
        campaign_id: campaignId,
        agent_id: agentId,
        twilio_number_id: opts.numberId,
        direction: "outbound",
        status: "completed",
        // First `connected` rows are connected outcomes; rest are voicemail.
        outcome: i < connected ? "gatekeeper" : "voicemail",
        outcome_source: "twilio",
      });
    }
    // Insert in chunks to avoid hitting payload limits.
    const CHUNK = 200;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const { error } = await admin
        .from("calls")
        .insert(rows.slice(i, i + CHUNK));
      if (error) throw new Error(`call seed failed: ${error.message}`);
    }
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
      .insert({ owner_id: ownerId, name: `E2E CR List ${stamp}` })
      .select("id")
      .single();
    listId = list!.id;

    const { data: lead } = await admin
      .from("leads")
      .insert({
        owner_id: ownerId,
        list_id: listId,
        company: `E2E CR Lead ${stamp}`,
        business_phone: `+1666${String(stamp).slice(-7)}`,
      })
      .select("id")
      .single();
    leadId = lead!.id;

    const { data: agent } = await admin
      .from("agents")
      .insert({
        owner_id: ownerId,
        name: `E2E CR Agent ${stamp}`,
        elevenlabs_agent_id: `cr-agent-${stamp}`,
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
      .insert({ owner_id: ownerId, name: `E2E CR Goal ${stamp}` })
      .select("id")
      .single();
    goalId = goal!.id;

    // Bootstrap a no-Twilio-number campaign for the FK constraint on calls.
    const { data: campaign } = await admin
      .from("campaigns")
      .insert({
        owner_id: ownerId,
        name: `E2E CR Campaign ${stamp}`,
        status: "active",
        agent_id: agentId,
        goal_id: goalId,
      })
      .select("id")
      .single();
    campaignId = campaign!.id;
  });

  test.afterAll(async () => {
    if (twilioNumberIds.length > 0) {
      await admin.from("notifications").delete().in("ref_id", twilioNumberIds);
      await admin
        .from("calls")
        .delete()
        .in("twilio_number_id", twilioNumberIds);
      await admin.from("twilio_numbers").delete().in("id", twilioNumberIds);
    }
    await admin
      .from("calls")
      .delete()
      .eq("lead_id", leadId ?? "");
    await admin
      .from("campaigns")
      .delete()
      .eq("id", campaignId ?? "");
    await admin
      .from("leads")
      .delete()
      .eq("id", leadId ?? "");
    await admin
      .from("agents")
      .delete()
      .eq("id", agentId ?? "");
    await admin
      .from("goals")
      .delete()
      .eq("id", goalId ?? "");
    await admin
      .from("lists")
      .delete()
      .eq("id", listId ?? "");
  });

  test("a number with <15% connect rate over 300+ calls gets flagged + notifies admins", async () => {
    const numberId = await seedNumber("Bad");
    // 300 calls, 10% connected → below 15% threshold.
    await seedCalls({ numberId, total: 300, connectedRatio: 0.1 });

    const { data: count } = await admin.rpc("monitor_twilio_connect_rates");
    expect((count as number) ?? 0).toBeGreaterThanOrEqual(1);

    const { data: n } = await admin
      .from("twilio_numbers")
      .select(
        "flagged_for_rotation, last_calls_count_24h, last_connect_rate_24h, last_connect_rate_check_at",
      )
      .eq("id", numberId)
      .single();
    expect(n?.flagged_for_rotation).toBe(true);
    expect(n?.last_calls_count_24h).toBe(300);
    // 0.1 ratio with some rounding leeway.
    expect(Number(n?.last_connect_rate_24h)).toBeCloseTo(0.1, 2);
    expect(n?.last_connect_rate_check_at).not.toBeNull();

    // One notification per admin. There are multiple admin users in the
    // workspace, so don't use .single().
    const { data: notifs } = await admin
      .from("notifications")
      .select("kind, message, ref_table, ref_id, user_id")
      .eq("ref_id", numberId);
    expect((notifs ?? []).length).toBeGreaterThanOrEqual(1);
    for (const n of notifs ?? []) {
      expect(n.kind).toBe("twilio_number_flagged");
      expect(n.ref_table).toBe("twilio_numbers");
      expect(n.message).toContain("connect rate");
    }
  });

  test("a number with healthy connect rate is not flagged", async () => {
    const numberId = await seedNumber("Good");
    // 300 calls, 50% connected → way above threshold.
    await seedCalls({ numberId, total: 300, connectedRatio: 0.5 });

    await admin.rpc("monitor_twilio_connect_rates");

    const { data: n } = await admin
      .from("twilio_numbers")
      .select(
        "flagged_for_rotation, last_calls_count_24h, last_connect_rate_24h",
      )
      .eq("id", numberId)
      .single();
    expect(n?.flagged_for_rotation).toBe(false);
    expect(n?.last_calls_count_24h).toBe(300);
    expect(Number(n?.last_connect_rate_24h)).toBeCloseTo(0.5, 2);
  });

  test("a number with too few calls is not flagged even at low connect rate", async () => {
    const numberId = await seedNumber("Tiny");
    // Only 100 calls (below 300 minimum), even at 0% connect rate.
    await seedCalls({ numberId, total: 100, connectedRatio: 0 });

    await admin.rpc("monitor_twilio_connect_rates");

    const { data: n } = await admin
      .from("twilio_numbers")
      .select(
        "flagged_for_rotation, last_calls_count_24h, last_connect_rate_24h",
      )
      .eq("id", numberId)
      .single();
    expect(n?.flagged_for_rotation).toBe(false);
    expect(n?.last_calls_count_24h).toBe(100);
    expect(Number(n?.last_connect_rate_24h)).toBe(0);
  });

  test("a second run on an already-flagged number doesn't notify again", async () => {
    const numberId = await seedNumber("DoubleRun");
    await seedCalls({ numberId, total: 300, connectedRatio: 0.1 });

    // First run → flag + notify.
    await admin.rpc("monitor_twilio_connect_rates");
    const { count: firstCount } = await admin
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("ref_id", numberId);
    expect(firstCount).toBeGreaterThanOrEqual(1);

    // Second run → already flagged, no new notification.
    await admin.rpc("monitor_twilio_connect_rates");
    const { count: secondCount } = await admin
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("ref_id", numberId);
    expect(secondCount).toBe(firstCount);
  });
});
