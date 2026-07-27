import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.describe.configure({ mode: "serial" });

/**
 * Per-number connect-rate HISTORY (twilio_number_daily_stats).
 *
 * The health monitor only keeps a rolling 24h snapshot on twilio_numbers, which
 * it overwrites every run. With per-number daily caps switched off, the trend is
 * the early-warning signal that a number is going bad, so it has to be durable
 * and correct: one row per number per EASTERN day, recomputed (not incremented)
 * so a re-run repairs rather than double-counts.
 */
test.describe("Number daily stats", () => {
  const stamp = Date.now();

  let admin: SupabaseClient;
  let ownerId: string;
  let listId: string;
  let leadId: string;
  let agentId: string;
  let goalId: string;
  let campaignId: string;
  let numberId: string;

  /** The Eastern calendar date for an instant — the bucket the function uses. */
  function easternDay(at: Date): string {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
    }).format(at);
  }

  async function seedCalls(opts: {
    total: number;
    connected: number;
    createdAt: Date;
  }): Promise<void> {
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < opts.total; i++) {
      rows.push({
        lead_id: leadId,
        campaign_id: campaignId,
        agent_id: agentId,
        twilio_number_id: numberId,
        direction: "outbound",
        status: "completed",
        outcome: i < opts.connected ? "gatekeeper" : "voicemail",
        outcome_source: "twilio",
        created_at: opts.createdAt.toISOString(),
      });
    }
    const { error } = await admin.from("calls").insert(rows);
    if (error) throw new Error(`call seed failed: ${error.message}`);
  }

  async function statFor(day: string) {
    const { data } = await admin
      .from("twilio_number_daily_stats")
      .select("calls, connected, connect_rate")
      .eq("twilio_number_id", numberId)
      .eq("day", day)
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
      .insert({ owner_id: ownerId, name: `E2E NDS List ${stamp}` })
      .select("id")
      .single();
    listId = list!.id;

    const { data: lead } = await admin
      .from("leads")
      .insert({
        owner_id: ownerId,
        list_id: listId,
        company: `E2E NDS Lead ${stamp}`,
        business_phone: `+1667${String(stamp).slice(-7)}`,
      })
      .select("id")
      .single();
    leadId = lead!.id;

    const { data: agent } = await admin
      .from("agents")
      .insert({
        owner_id: ownerId,
        name: `E2E NDS Agent ${stamp}`,
        elevenlabs_agent_id: `nds-agent-${stamp}`,
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
      .insert({ owner_id: ownerId, name: `E2E NDS Goal ${stamp}` })
      .select("id")
      .single();
    goalId = goal!.id;

    const { data: campaign } = await admin
      .from("campaigns")
      .insert({
        owner_id: ownerId,
        name: `E2E NDS Campaign ${stamp}`,
        status: "active",
        agent_id: agentId,
        goal_id: goalId,
      })
      .select("id")
      .single();
    campaignId = campaign!.id;

    const { data: number } = await admin
      .from("twilio_numbers")
      .insert({
        phone_number: `+1557${Math.floor(Math.random() * 1e7)
          .toString()
          .padStart(7, "0")}`,
        friendly_name: `E2E NDS Number ${stamp}`,
        country: "US",
      })
      .select("id")
      .single();
    numberId = number!.id;
  });

  test.afterAll(async () => {
    // The stats rows cascade off twilio_numbers, but delete calls first so the
    // FK on calls.twilio_number_id doesn't block the number delete.
    await admin
      .from("calls")
      .delete()
      .eq("twilio_number_id", numberId ?? "");
    await admin
      .from("twilio_numbers")
      .delete()
      .eq("id", numberId ?? "");
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

  test("buckets a day's calls into one row with the right connect rate", async () => {
    const today = new Date();
    await seedCalls({ total: 10, connected: 4, createdAt: today });

    await admin.rpc("refresh_twilio_number_daily_stats", { in_days_back: 3 });

    const row = await statFor(easternDay(today));
    expect(row?.calls).toBe(10);
    expect(row?.connected).toBe(4);
    expect(Number(row?.connect_rate)).toBeCloseTo(0.4, 3);
  });

  test("re-running recomputes instead of double-counting", async () => {
    const today = new Date();

    // Idempotence: the cron fires every 30 minutes over the same day.
    await admin.rpc("refresh_twilio_number_daily_stats", { in_days_back: 3 });
    await admin.rpc("refresh_twilio_number_daily_stats", { in_days_back: 3 });

    const row = await statFor(easternDay(today));
    expect(row?.calls).toBe(10);
    expect(row?.connected).toBe(4);
  });

  test("picks up calls that land after the first pass", async () => {
    const today = new Date();
    // 5 more calls, all connected → 15 total, 9 connected.
    await seedCalls({ total: 5, connected: 5, createdAt: today });

    await admin.rpc("refresh_twilio_number_daily_stats", { in_days_back: 3 });

    const row = await statFor(easternDay(today));
    expect(row?.calls).toBe(15);
    expect(row?.connected).toBe(9);
    expect(Number(row?.connect_rate)).toBeCloseTo(0.6, 3);
  });

  test("keeps each Eastern day in its own row", async () => {
    const today = new Date();
    // Midday ET two days ago, so the bucket can't straddle a day boundary
    // whatever time the suite runs.
    const twoDaysAgo = new Date(today.getTime() - 2 * 86_400_000);
    twoDaysAgo.setUTCHours(17, 0, 0, 0);
    await seedCalls({ total: 8, connected: 2, createdAt: twoDaysAgo });

    await admin.rpc("refresh_twilio_number_daily_stats", { in_days_back: 5 });

    const older = await statFor(easternDay(twoDaysAgo));
    expect(older?.calls).toBe(8);
    expect(older?.connected).toBe(2);

    // Today's row is untouched by the backdated calls.
    const current = await statFor(easternDay(today));
    expect(current?.calls).toBe(15);
  });

  test("ignores days outside the requested window", async () => {
    const today = new Date();
    const longAgo = new Date(today.getTime() - 30 * 86_400_000);
    longAgo.setUTCHours(17, 0, 0, 0);
    await seedCalls({ total: 6, connected: 6, createdAt: longAgo });

    // Window of 5 days must not reach back 30 days.
    await admin.rpc("refresh_twilio_number_daily_stats", { in_days_back: 5 });
    expect(await statFor(easternDay(longAgo))).toBeNull();

    // A wide enough window backfills it.
    await admin.rpc("refresh_twilio_number_daily_stats", { in_days_back: 40 });
    const row = await statFor(easternDay(longAgo));
    expect(row?.calls).toBe(6);
    expect(Number(row?.connect_rate)).toBeCloseTo(1, 3);
  });
});
