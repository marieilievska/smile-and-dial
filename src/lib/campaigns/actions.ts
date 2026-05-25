"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";

export type CampaignResult = { error: string | null; campaignId?: string };

const CAMPAIGNS_PATH = "/campaigns";

/** Confirm the caller is signed in. RLS handles owner-or-admin scoping. */
async function requireAuth(): Promise<{
  supabase: Awaited<ReturnType<typeof createClient>>;
  userId: string | null;
  error: string | null;
}> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { supabase, userId: null, error: "You are not signed in." };
  return { supabase, userId: user.id, error: null };
}

export type CampaignInput = {
  name: string;
  description: string;
  agentId: string;
  goalId: string;
  twilioNumberId: string;
  callingHoursStart: string;
  callingHoursEnd: string;
  callsPerHourCap: string;
  callsPerDayCap: string;
  concurrencyCapPerUser: string;
  transferDestinationPhone: string;
  dailySpendCap: string;
  monthlySpendCap: string;
};

function parseNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}

function parseTime(value: string, fallback: string): string {
  const match = /^(\d{1,2}):(\d{2})/.exec(value.trim());
  if (!match) return fallback;
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

function buildUpdate(input: CampaignInput) {
  return {
    name: input.name.trim(),
    description: input.description.trim() || null,
    agent_id: input.agentId,
    goal_id: input.goalId,
    twilio_number_id: input.twilioNumberId || null,
    calling_hours_start: parseTime(input.callingHoursStart, "09:00"),
    calling_hours_end: parseTime(input.callingHoursEnd, "21:00"),
    calls_per_hour_cap: parseNumber(input.callsPerHourCap) ?? 30,
    calls_per_day_cap: parseNumber(input.callsPerDayCap) ?? 300,
    concurrency_cap_per_user: Math.min(
      5,
      Math.max(1, parseNumber(input.concurrencyCapPerUser) ?? 2),
    ),
    transfer_destination_phone: input.transferDestinationPhone.trim() || null,
    daily_spend_cap: parseNumber(input.dailySpendCap),
    monthly_spend_cap: parseNumber(input.monthlySpendCap),
  };
}

/**
 * Keep twilio_numbers.attached_campaign_id in sync with whatever campaign
 * currently owns each number. Called after every create/update that may
 * change the campaign's number.
 */
async function syncTwilioAttachment(
  supabase: Awaited<ReturnType<typeof createClient>>,
  campaignId: string,
  newNumberId: string | null,
  previousNumberId: string | null,
) {
  if (previousNumberId && previousNumberId !== newNumberId) {
    await supabase
      .from("twilio_numbers")
      .update({ attached_campaign_id: null })
      .eq("id", previousNumberId);
  }
  if (newNumberId) {
    await supabase
      .from("twilio_numbers")
      .update({ attached_campaign_id: campaignId })
      .eq("id", newNumberId);
  }
}

/** Create a campaign. */
export async function createCampaign(
  input: CampaignInput,
): Promise<CampaignResult> {
  if (!input.name.trim()) return { error: "Give the campaign a name." };
  if (!input.agentId) return { error: "Pick an agent." };
  if (!input.goalId) return { error: "Pick a goal." };

  const { supabase, userId, error: authError } = await requireAuth();
  if (authError) return { error: authError };

  const payload = buildUpdate(input);
  const { data: created, error } = await supabase
    .from("campaigns")
    .insert({ owner_id: userId!, ...payload })
    .select("id")
    .single();
  if (error || !created) return { error: "Could not create the campaign." };

  await syncTwilioAttachment(
    supabase,
    created.id,
    payload.twilio_number_id,
    null,
  );
  revalidatePath(CAMPAIGNS_PATH);
  return { error: null, campaignId: created.id };
}

/** Update an existing campaign. */
export async function updateCampaign(
  id: string,
  input: CampaignInput,
): Promise<CampaignResult> {
  if (!input.name.trim()) return { error: "Give the campaign a name." };
  if (!input.agentId) return { error: "Pick an agent." };
  if (!input.goalId) return { error: "Pick a goal." };

  const { supabase, error: authError } = await requireAuth();
  if (authError) return { error: authError };

  const { data: existing } = await supabase
    .from("campaigns")
    .select("twilio_number_id")
    .eq("id", id)
    .maybeSingle();

  const payload = buildUpdate(input);
  const { error } = await supabase
    .from("campaigns")
    .update(payload)
    .eq("id", id);
  if (error) return { error: "Could not update the campaign." };

  await syncTwilioAttachment(
    supabase,
    id,
    payload.twilio_number_id,
    existing?.twilio_number_id ?? null,
  );
  revalidatePath(CAMPAIGNS_PATH);
  return { error: null, campaignId: id };
}

/** Pause a campaign — stops new dials; in-progress calls finish. */
export async function pauseCampaign(id: string): Promise<CampaignResult> {
  const { supabase, error: authError } = await requireAuth();
  if (authError) return { error: authError };

  const { error } = await supabase
    .from("campaigns")
    .update({
      status: "paused",
      paused_at: new Date().toISOString(),
      paused_reason: "manual",
    })
    .eq("id", id);
  if (error) return { error: "Could not pause the campaign." };

  revalidatePath(CAMPAIGNS_PATH);
  return { error: null, campaignId: id };
}

/** Resume a paused campaign. */
export async function resumeCampaign(id: string): Promise<CampaignResult> {
  const { supabase, error: authError } = await requireAuth();
  if (authError) return { error: authError };

  const { error } = await supabase
    .from("campaigns")
    .update({
      status: "active",
      paused_at: null,
      paused_reason: null,
    })
    .eq("id", id);
  if (error) return { error: "Could not resume the campaign." };

  revalidatePath(CAMPAIGNS_PATH);
  return { error: null, campaignId: id };
}

/**
 * End a campaign. Marks it ended and releases its Twilio number back to the
 * pool. List detachment lands with the Lists tab in Step 19.
 */
export async function endCampaign(id: string): Promise<CampaignResult> {
  const { supabase, error: authError } = await requireAuth();
  if (authError) return { error: authError };

  const { data: existing } = await supabase
    .from("campaigns")
    .select("twilio_number_id")
    .eq("id", id)
    .maybeSingle();

  const { error } = await supabase
    .from("campaigns")
    .update({
      status: "ended",
      ended_at: new Date().toISOString(),
      twilio_number_id: null,
    })
    .eq("id", id);
  if (error) return { error: "Could not end the campaign." };

  if (existing?.twilio_number_id) {
    await supabase
      .from("twilio_numbers")
      .update({ attached_campaign_id: null })
      .eq("id", existing.twilio_number_id);
  }

  // Detach every list still attached to this campaign.
  await supabase
    .from("list_campaign_attachments")
    .update({ detached_at: new Date().toISOString() })
    .eq("campaign_id", id)
    .is("detached_at", null);

  revalidatePath(CAMPAIGNS_PATH);
  revalidatePath("/settings/lists");
  return { error: null, campaignId: id };
}

/**
 * Clone a campaign. Copies all settings except the Twilio number (numbers
 * are exclusive to one campaign). The agent is preserved so the row stays
 * valid; the admin re-selects voice/number/etc. by editing the copy.
 */
export async function cloneCampaign(id: string): Promise<CampaignResult> {
  const { supabase, userId, error: authError } = await requireAuth();
  if (authError) return { error: authError };

  const { data: original } = await supabase
    .from("campaigns")
    .select(
      "name, description, agent_id, goal_id, calling_hours_start, calling_hours_end, calls_per_hour_cap, calls_per_day_cap, concurrency_cap_per_user, transfer_destination_phone, daily_spend_cap, monthly_spend_cap",
    )
    .eq("id", id)
    .maybeSingle();
  if (!original) return { error: "That campaign no longer exists." };

  const { data: created, error } = await supabase
    .from("campaigns")
    .insert({
      owner_id: userId!,
      name: `${original.name} (copy)`,
      description: original.description,
      agent_id: original.agent_id,
      goal_id: original.goal_id,
      twilio_number_id: null,
      calling_hours_start: original.calling_hours_start,
      calling_hours_end: original.calling_hours_end,
      calls_per_hour_cap: original.calls_per_hour_cap,
      calls_per_day_cap: original.calls_per_day_cap,
      concurrency_cap_per_user: original.concurrency_cap_per_user,
      transfer_destination_phone: original.transfer_destination_phone,
      daily_spend_cap: original.daily_spend_cap,
      monthly_spend_cap: original.monthly_spend_cap,
      status: "active",
    })
    .select("id")
    .single();
  if (error || !created) return { error: "Could not clone the campaign." };

  revalidatePath(CAMPAIGNS_PATH);
  return { error: null, campaignId: created.id };
}

/** Delete a campaign. */
export async function deleteCampaign(id: string): Promise<CampaignResult> {
  const { supabase, error: authError } = await requireAuth();
  if (authError) return { error: authError };

  const { data: existing } = await supabase
    .from("campaigns")
    .select("twilio_number_id")
    .eq("id", id)
    .maybeSingle();

  const { error } = await supabase.from("campaigns").delete().eq("id", id);
  if (error) return { error: "Could not delete the campaign." };

  if (existing?.twilio_number_id) {
    await supabase
      .from("twilio_numbers")
      .update({ attached_campaign_id: null })
      .eq("id", existing.twilio_number_id);
  }

  revalidatePath(CAMPAIGNS_PATH);
  return { error: null, campaignId: id };
}
