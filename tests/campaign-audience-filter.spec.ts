import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.use({ storageState: "playwright/.auth/user.json" });

test.describe.configure({ mode: "serial" });

/**
 * Campaign audience filters: a campaign with `audience_search` calls leads by
 * company name regardless of which list they live in, and a lead matching more
 * than one campaign is dialed by exactly one (the double-call guard). Poked
 * directly through the service-role client against dial_queue.
 */
test.describe("Campaign audience filter", () => {
  const stamp = Date.now();
  const tail = String(stamp).slice(-6);
  const token = `F45AUD${tail}`; // unique company-name token for this run
  const phoneFilter = `+1555${tail}11`;
  const phoneShared = `+1555${tail}22`;

  let admin: SupabaseClient;
  let ownerId: string;
  let unattachedListId: string;
  let attachedListId: string;
  let filterCampaignId: string; // newer; targets by audience_search only
  let listCampaignId: string; // older; targets by an attached list
  let numA: string;
  let numB: string;
  let agentId: string;
  let goalId: string;
  let leadFilterId: string; // in an unattached list, matches the filter
  let leadSharedId: string; // in the attached list AND matches the filter

  async function seedNumber(suffix: string): Promise<string> {
    const { data } = await admin
      .from("twilio_numbers")
      .insert({
        phone_number: `+1555${tail}${suffix}`,
        friendly_name: `E2E Aud Number ${suffix} ${stamp}`,
        country: "US",
      })
      .select("id")
      .single();
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

    const { data: agent } = await admin
      .from("agents")
      .insert({
        owner_id: ownerId,
        name: `E2E Aud Agent ${stamp}`,
        elevenlabs_agent_id: `e2e-aud-${stamp}`,
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
      .insert({ owner_id: ownerId, name: `E2E Aud Goal ${stamp}` })
      .select("id")
      .single();
    goalId = goal!.id;

    const { data: listU } = await admin
      .from("lists")
      .insert({ owner_id: ownerId, name: `E2E Aud Unattached ${stamp}` })
      .select("id")
      .single();
    unattachedListId = listU!.id;

    const { data: listA } = await admin
      .from("lists")
      .insert({ owner_id: ownerId, name: `E2E Aud Attached ${stamp}` })
      .select("id")
      .single();
    attachedListId = listA!.id;

    numA = await seedNumber("31");
    numB = await seedNumber("32");

    // Older campaign: list-based, attached to attachedListId.
    const { data: listCampaign } = await admin
      .from("campaigns")
      .insert({
        owner_id: ownerId,
        name: `E2E Aud List Campaign ${stamp}`,
        status: "active",
        agent_id: agentId,
        goal_id: goalId,
        twilio_number_id: numA,
        calling_hours_start: "00:00:00",
        calling_hours_end: "23:59:59",
      })
      .select("id")
      .single();
    listCampaignId = listCampaign!.id;

    // Newer campaign: filter-based, audience_search = token, NO list attached.
    const { data: filterCampaign } = await admin
      .from("campaigns")
      .insert({
        owner_id: ownerId,
        name: `E2E Aud Filter Campaign ${stamp}`,
        status: "active",
        agent_id: agentId,
        goal_id: goalId,
        twilio_number_id: numB,
        audience_search: token,
        calling_hours_start: "00:00:00",
        calling_hours_end: "23:59:59",
      })
      .select("id")
      .single();
    filterCampaignId = filterCampaign!.id;

    await admin
      .from("twilio_numbers")
      .update({ attached_campaign_id: listCampaignId })
      .eq("id", numA);
    await admin
      .from("twilio_numbers")
      .update({ attached_campaign_id: filterCampaignId })
      .eq("id", numB);

    await admin.from("list_campaign_attachments").insert({
      list_id: attachedListId,
      campaign_id: listCampaignId,
    });

    // Lead that ONLY the filter campaign should reach: lives in an unattached
    // list, but its company contains the token.
    const { data: leadFilter } = await admin
      .from("leads")
      .insert({
        owner_id: ownerId,
        list_id: unattachedListId,
        company: `${token} Downtown`,
        business_phone: phoneFilter,
        timezone: "America/New_York",
        status: "ready_to_call",
      })
      .select("id")
      .single();
    leadFilterId = leadFilter!.id;

    // Lead that BOTH campaigns want: in the attached list (list campaign) and
    // its company contains the token (filter campaign).
    const { data: leadShared } = await admin
      .from("leads")
      .insert({
        owner_id: ownerId,
        list_id: attachedListId,
        company: `${token} Uptown`,
        business_phone: phoneShared,
        timezone: "America/New_York",
        status: "ready_to_call",
      })
      .select("id")
      .single();
    leadSharedId = leadShared!.id;
  });

  test.afterAll(async () => {
    for (const id of [leadFilterId, leadSharedId]) {
      await admin
        .from("calls")
        .delete()
        .eq("lead_id", id ?? "");
      await admin
        .from("leads")
        .delete()
        .eq("id", id ?? "");
    }
    await admin.from("dnc_entries").delete().eq("phone", phoneFilter);
    await admin.from("dnc_entries").delete().eq("phone", phoneShared);
    for (const id of [filterCampaignId, listCampaignId]) {
      await admin
        .from("list_campaign_attachments")
        .delete()
        .eq("campaign_id", id ?? "");
    }
    for (const id of [numA, numB]) {
      await admin
        .from("twilio_numbers")
        .update({ attached_campaign_id: null })
        .eq("id", id ?? "");
    }
    for (const id of [filterCampaignId, listCampaignId]) {
      await admin
        .from("campaigns")
        .delete()
        .eq("id", id ?? "");
    }
    await admin
      .from("agents")
      .delete()
      .eq("id", agentId ?? "");
    for (const id of [numA, numB]) {
      await admin
        .from("twilio_numbers")
        .delete()
        .eq("id", id ?? "");
    }
    await admin
      .from("goals")
      .delete()
      .eq("id", goalId ?? "");
    for (const id of [unattachedListId, attachedListId]) {
      await admin
        .from("lists")
        .delete()
        .eq("id", id ?? "");
    }
  });

  async function queueRows(leadId: string) {
    const { data } = await admin
      .from("dial_queue")
      .select("lead_id, campaign_id")
      .eq("lead_id", leadId);
    return data ?? [];
  }

  test("a lead matches a campaign's audience filter even when its list isn't attached", async () => {
    const rows = await queueRows(leadFilterId);
    expect(rows.length).toBe(1);
    expect(rows[0].campaign_id).toBe(filterCampaignId);
  });

  test("a lead matching two campaigns is queued once, for the older campaign", async () => {
    const rows = await queueRows(leadSharedId);
    // Double-call guard: exactly one row, and the older (list) campaign wins.
    expect(rows.length).toBe(1);
    expect(rows[0].campaign_id).toBe(listCampaignId);
  });
});
