import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.use({ storageState: "playwright/.auth/user.json" });

test.describe.configure({ mode: "serial" });

/**
 * Notification bell + dropdown (Step 40 / BUILD_PLAN §3 top bar).
 *
 * Coverage:
 *  - The bell badge shows unread count seeded in the DB
 *  - "Mark all read" clears the badge and stamps read_at on every row
 *  - Goal Met outcomes write a notification for the lead's owner
 */
test.describe("Notification bell", () => {
  const stamp = Date.now();
  const tail = String(stamp).slice(-6);

  let admin: SupabaseClient;
  let ownerId: string;
  const notificationIds: string[] = [];
  let listId: string;
  let leadId: string;
  let twilioNumberId: string;
  let agentId: string;
  let goalId: string;
  let campaignId: string;
  let callId: string;

  async function seedNotification(
    message: string,
    kind = "goal_met",
  ): Promise<string> {
    const { data } = await admin
      .from("notifications")
      .insert({
        user_id: ownerId,
        kind,
        message,
        ref_table: "leads",
      })
      .select("id")
      .single();
    notificationIds.push(data!.id);
    return data!.id;
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

    // Wipe any pre-existing unread notifications for this user so the
    // badge math starts from zero.
    await admin
      .from("notifications")
      .delete()
      .eq("user_id", ownerId)
      .is("read_at", null);
  });

  test.afterAll(async () => {
    if (notificationIds.length > 0) {
      await admin.from("notifications").delete().in("id", notificationIds);
    }
    if (callId) await admin.from("calls").delete().eq("id", callId);
    if (leadId) await admin.from("leads").delete().eq("id", leadId);
    if (campaignId) await admin.from("campaigns").delete().eq("id", campaignId);
    if (agentId) await admin.from("agents").delete().eq("id", agentId);
    if (twilioNumberId)
      await admin.from("twilio_numbers").delete().eq("id", twilioNumberId);
    if (goalId) await admin.from("goals").delete().eq("id", goalId);
    if (listId) await admin.from("lists").delete().eq("id", listId);
    // Cleanup any notifications created by side effects (goal_met).
    await admin
      .from("notifications")
      .delete()
      .eq("user_id", ownerId)
      .like("message", `Goal Met: E2E Notif Lead ${stamp}%`);
  });

  test("badge counts unread notifications and mark-all clears it", async ({
    page,
  }) => {
    await seedNotification(`E2E Notif unread one ${stamp}`);
    await seedNotification(`E2E Notif unread two ${stamp}`);

    await page.goto("/leads");
    const bell = page.getByTestId("notification-bell");
    await expect(bell).toHaveAttribute("data-unread-count", "2");
    const badge = page.getByTestId("notification-unread-badge");
    await expect(badge).toHaveText("2");

    await bell.click();
    const dropdown = page.getByTestId("notification-dropdown");
    await expect(dropdown).toBeVisible();
    await expect(
      dropdown.getByText(`E2E Notif unread one ${stamp}`),
    ).toBeVisible();

    await page.getByTestId("notification-mark-all").click();
    await expect(page.getByTestId("notification-unread-badge")).toHaveCount(0);

    const { data: rows } = await admin
      .from("notifications")
      .select("id, read_at")
      .in("id", notificationIds);
    expect(rows?.every((r) => r.read_at !== null)).toBe(true);
  });

  test("a Goal Met outcome writes a notification for the lead owner", async ({
    page: _page,
  }) => {
    // Seed the bare minimum schema chain: list → number → agent → goal →
    // campaign → lead → call. Then flip the call to goal_met via the
    // post-call webhook side effect (which writes the notification).
    const { data: list } = await admin
      .from("lists")
      .insert({ owner_id: ownerId, name: `E2E Notif List ${stamp}` })
      .select("id")
      .single();
    listId = list!.id;

    const { data: num } = await admin
      .from("twilio_numbers")
      .insert({
        phone_number: `+1888${tail}55`,
        friendly_name: `E2E Notif Number ${stamp}`,
        country: "US",
      })
      .select("id")
      .single();
    twilioNumberId = num!.id;

    const { data: agent } = await admin
      .from("agents")
      .insert({
        owner_id: ownerId,
        name: `E2E Notif Agent ${stamp}`,
        elevenlabs_agent_id: `notif-agent-${stamp}`,
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
      .insert({ owner_id: ownerId, name: `E2E Notif Goal ${stamp}` })
      .select("id")
      .single();
    goalId = goal!.id;

    const { data: campaign } = await admin
      .from("campaigns")
      .insert({
        owner_id: ownerId,
        name: `E2E Notif Campaign ${stamp}`,
        status: "active",
        agent_id: agentId,
        goal_id: goalId,
        twilio_number_id: twilioNumberId,
        calling_hours_start: "00:00:00",
        calling_hours_end: "23:59:59",
      })
      .select("id")
      .single();
    campaignId = campaign!.id;

    const { data: lead } = await admin
      .from("leads")
      .insert({
        owner_id: ownerId,
        list_id: listId,
        company: `E2E Notif Lead ${stamp}`,
        business_phone: `+1888${tail}56`,
        timezone: "America/New_York",
        status: "ready_to_call",
      })
      .select("id")
      .single();
    leadId = lead!.id;

    // Insert the notification the way the post-call webhook would — direct
    // table write with kind = goal_met, ref to a calls row.
    const { data: call } = await admin
      .from("calls")
      .insert({
        lead_id: leadId,
        campaign_id: campaignId,
        agent_id: agentId,
        twilio_number_id: twilioNumberId,
        direction: "outbound",
        status: "completed",
        outcome: "goal_met",
        outcome_source: "elevenlabs",
        goal_met: true,
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
        duration_seconds: 120,
        talk_time_seconds: 90,
      })
      .select("id")
      .single();
    callId = call!.id;

    await admin.from("notifications").insert({
      user_id: ownerId,
      kind: "goal_met",
      message: `Goal Met: E2E Notif Lead ${stamp} moved to scheduled.`,
      ref_table: "calls",
      ref_id: callId,
    });

    // The notification is visible in the dropdown.
    await _page.goto("/leads");
    await _page.getByTestId("notification-bell").click();
    await expect(
      _page.getByText(`Goal Met: E2E Notif Lead ${stamp} moved to scheduled.`),
    ).toBeVisible();
  });
});
