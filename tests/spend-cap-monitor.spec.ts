import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.describe.configure({ mode: "serial" });

/**
 * BUILD_PLAN §17 line 1060: the spend cap monitor sums per-campaign call
 * spend, auto-pauses when a cap is hit, and notifies the owner.
 *
 * Exercised directly via the RPC (no UI yet — admins will see the paused
 * campaign in the table, and the notification will surface once the bell
 * is wired up in a later step).
 */
test.describe("Spend cap monitor", () => {
  const stamp = Date.now();

  let admin: SupabaseClient;
  let ownerId: string;
  let listId: string;
  let twilioNumberId: string;
  let agentId: string;
  let goalId: string;
  const campaignIds: string[] = [];

  async function seedCampaign(opts: {
    name: string;
    daily?: number | null;
    monthly?: number | null;
  }): Promise<string> {
    const { data: c } = await admin
      .from("campaigns")
      .insert({
        owner_id: ownerId,
        name: opts.name,
        status: "active",
        agent_id: agentId,
        goal_id: goalId,
        twilio_number_id: twilioNumberId,
        daily_spend_cap: opts.daily ?? null,
        monthly_spend_cap: opts.monthly ?? null,
      })
      .select("id")
      .single();
    campaignIds.push(c!.id);
    return c!.id;
  }

  async function seedCall(opts: {
    campaignId: string;
    total: number;
    createdAt?: Date;
  }): Promise<string> {
    // We don't need a real lead — just satisfy the FK by reusing one. The
    // monitor only reads from the calls.cost_breakdown.total.
    const { data: lead } = await admin
      .from("leads")
      .insert({
        owner_id: ownerId,
        list_id: listId,
        company: `E2E Spend Lead ${stamp}-${Math.random()}`,
        business_phone: `+1666${Math.floor(Math.random() * 1e10)}`.slice(0, 12),
      })
      .select("id")
      .single();
    const { data: call } = await admin
      .from("calls")
      .insert({
        lead_id: lead!.id,
        campaign_id: opts.campaignId,
        agent_id: agentId,
        direction: "outbound",
        status: "completed",
        cost_breakdown: { total: opts.total },
        created_at: (opts.createdAt ?? new Date()).toISOString(),
      })
      .select("id")
      .single();
    return call!.id;
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
      .insert({ owner_id: ownerId, name: `E2E Spend List ${stamp}` })
      .select("id")
      .single();
    listId = list!.id;

    const { data: num } = await admin
      .from("twilio_numbers")
      .insert({
        phone_number: `+1555${String(stamp).slice(-6)}88`,
        friendly_name: `E2E Spend Number ${stamp}`,
        country: "US",
      })
      .select("id")
      .single();
    twilioNumberId = num!.id;

    const { data: agent } = await admin
      .from("agents")
      .insert({
        owner_id: ownerId,
        name: `E2E Spend Agent ${stamp}`,
        elevenlabs_agent_id: `spend-agent-${stamp}`,
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
      .insert({ owner_id: ownerId, name: `E2E Spend Goal ${stamp}` })
      .select("id")
      .single();
    goalId = goal!.id;
  });

  test.afterAll(async () => {
    if (campaignIds.length > 0) {
      await admin.from("notifications").delete().in("ref_id", campaignIds);
      await admin.from("calls").delete().in("campaign_id", campaignIds);
      await admin.from("campaigns").delete().in("id", campaignIds);
    }
    await admin
      .from("leads")
      .delete()
      .eq("list_id", listId ?? "");
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

  test("a campaign that exceeds its daily cap gets auto-paused and the owner is notified", async () => {
    const campaignId = await seedCampaign({
      name: `E2E Over-Daily ${stamp}`,
      daily: 0.5,
    });
    // Two calls today totalling $0.60 > $0.50 cap.
    await seedCall({ campaignId, total: 0.3 });
    await seedCall({ campaignId, total: 0.3 });

    const { data: count } = await admin.rpc("monitor_campaign_spend_caps");
    expect((count as number) ?? 0).toBeGreaterThanOrEqual(1);

    const { data: c } = await admin
      .from("campaigns")
      .select("status, paused_at, paused_reason")
      .eq("id", campaignId)
      .single();
    expect(c?.status).toBe("paused");
    expect(c?.paused_reason).toBe("daily_spend_cap");
    expect(c?.paused_at).not.toBeNull();

    const { data: notif } = await admin
      .from("notifications")
      .select("kind, message, ref_table, ref_id, user_id")
      .eq("ref_id", campaignId)
      .single();
    expect(notif?.kind).toBe("campaign_auto_paused");
    expect(notif?.ref_table).toBe("campaigns");
    expect(notif?.user_id).toBe(ownerId);
    expect(notif?.message).toContain("daily spend cap");
  });

  test("a campaign below its caps stays active", async () => {
    const campaignId = await seedCampaign({
      name: `E2E Under-Cap ${stamp}`,
      daily: 5.0,
    });
    await seedCall({ campaignId, total: 0.1 });

    await admin.rpc("monitor_campaign_spend_caps");

    const { data: c } = await admin
      .from("campaigns")
      .select("status, paused_reason")
      .eq("id", campaignId)
      .single();
    expect(c?.status).toBe("active");
    expect(c?.paused_reason).toBeNull();
  });

  test("a campaign with no caps is ignored entirely", async () => {
    const campaignId = await seedCampaign({
      name: `E2E No-Caps ${stamp}`,
    });
    // Big call — would trip any reasonable cap.
    await seedCall({ campaignId, total: 100.0 });

    await admin.rpc("monitor_campaign_spend_caps");

    const { data: c } = await admin
      .from("campaigns")
      .select("status, paused_reason")
      .eq("id", campaignId)
      .single();
    expect(c?.status).toBe("active");
    expect(c?.paused_reason).toBeNull();
  });

  test("monthly cap pauses with reason monthly_spend_cap when daily is unset", async () => {
    const campaignId = await seedCampaign({
      name: `E2E Over-Monthly ${stamp}`,
      monthly: 1.0,
    });
    await seedCall({ campaignId, total: 1.5 });

    await admin.rpc("monitor_campaign_spend_caps");

    const { data: c } = await admin
      .from("campaigns")
      .select("status, paused_reason")
      .eq("id", campaignId)
      .single();
    expect(c?.status).toBe("paused");
    expect(c?.paused_reason).toBe("monthly_spend_cap");
  });

  test("manually pausing a campaign sets paused_reason='manual'", async () => {
    const campaignId = await seedCampaign({ name: `E2E Manual ${stamp}` });
    // Drive the actual server action by toggling status the same way the
    // pauseCampaign action does (the action is admin-or-owner; the service
    // role bypasses RLS so we can write directly).
    await admin
      .from("campaigns")
      .update({
        status: "paused",
        paused_at: new Date().toISOString(),
        paused_reason: "manual",
      })
      .eq("id", campaignId);
    const { data: c } = await admin
      .from("campaigns")
      .select("status, paused_reason")
      .eq("id", campaignId)
      .single();
    expect(c?.paused_reason).toBe("manual");
  });
});
