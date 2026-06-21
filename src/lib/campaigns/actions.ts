"use server";

import { revalidatePath } from "next/cache";

import type { ToolsEnabled } from "@/lib/agents/prompt";
import { sanitizeAudienceSearch } from "@/lib/campaigns/audience-filter";
import { applyConnectedAgentIntegration } from "@/lib/elevenlabs/agents";
import { createClient } from "@/lib/supabase/server";
import { ensureNumberImportedToElevenLabs } from "@/lib/twilio/place-call";

export type CampaignResult = { error: string | null; campaignId?: string };

const CAMPAIGNS_PATH = "/campaigns";

/**
 * Re-apply our ElevenLabs integration (post-call + conversation-init webhooks,
 * the call_id dynamic variable, server tool_ids) to a campaign's agent.
 *
 * Attaching an agent to a campaign — or (re)activating one — is the moment that
 * agent goes into service, so we refresh its webhook wiring here. Without this,
 * an agent that was synced long ago (e.g. when the post-call webhook id was
 * different, or whose connect-time overlay failed) keeps a stale/dead webhook,
 * and ElevenLabs delivers its transcripts/audio to an address we no longer own —
 * so completed calls never show up in Smile & Dial.
 *
 * `campaignAgentId` is the local agents.id stored on the campaign. Best-effort:
 * a sync hiccup never blocks the campaign action (and "Re-sync all agents"
 * remains the manual fallback). Off-live this is a no-op (mocked).
 */
async function reapplyAgentIntegration(
  supabase: Awaited<ReturnType<typeof createClient>>,
  campaignAgentId: string | null | undefined,
): Promise<void> {
  if (!campaignAgentId) return;
  const { data: agent } = await supabase
    .from("agents")
    .select("elevenlabs_agent_id, tools_enabled")
    .eq("id", campaignAgentId)
    .maybeSingle();
  if (!agent?.elevenlabs_agent_id) return;
  try {
    await applyConnectedAgentIntegration(
      agent.elevenlabs_agent_id,
      (agent.tools_enabled ?? undefined) as unknown as ToolsEnabled | undefined,
    );
  } catch {
    // best-effort — never block a campaign action on a sync hiccup
  }
}

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
  /** When false the AI auto-dialer skips this campaign; manual Call Now still
   *  works. Optional so existing call sites default it to on. */
  autopilotEnabled?: boolean;
  /** When true, retries aim for each lead's best-answering hour (in their
   *  timezone) instead of a fixed time window. Optional, defaults to false. */
  smartSchedulingEnabled?: boolean;
  /** Calendly event type (calendly_event_types.id) the booking tools check
   *  availability against and book into. Empty = booking is OFF for this
   *  campaign (the agent won't offer times or book; no fallback event). */
  calendlyEventId?: string;
  /** Email template (email_templates.id) the send_email tool sends. Empty =
   *  no template, the tool only records intent. */
  emailTemplateId?: string;
  /** Optional company-name "contains" filter. When set, the campaign also
   *  targets every lead (same owner) whose company name contains this text,
   *  regardless of list. Empty = list-only targeting. */
  audienceSearch?: string;
  /** Optional attached smart list id (smart_lists.id). When set, the campaign
   *  also dials every member of that smart list. Empty = no smart list. */
  smartListId?: string;
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
    autopilot_enabled: input.autopilotEnabled ?? true,
    smart_scheduling: input.smartSchedulingEnabled ?? false,
    calendly_event_id: input.calendlyEventId?.trim() || null,
    email_template_id: input.emailTemplateId?.trim() || null,
    audience_search: sanitizeAudienceSearch(input.audienceSearch ?? "") || null,
    smart_list_id: input.smartListId?.trim() || null,
  };
}

/** Rebuild a smart list's member cache immediately so a freshly attached list
 *  is callable within seconds, not at the next cron tick. Best-effort: the cron
 *  is the backstop, so a hiccup never blocks the save. */
async function refreshAttachedSmartList(
  supabase: Awaited<ReturnType<typeof createClient>>,
  smartListId: string | null | undefined,
): Promise<void> {
  if (!smartListId) return;
  try {
    await supabase.rpc("refresh_smart_list", { in_id: smartListId });
  } catch {
    // best-effort — the 3-min cron will reconcile
  }
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
    // Register the attached number with ElevenLabs now (cached on the row) so
    // outbound is ready before the first dial — the gap that left a freshly
    // attached number unknown to ElevenLabs. Best-effort: never block the
    // campaign save on an ElevenLabs hiccup; the per-number "Connect to
    // ElevenLabs" button is the visible retry.
    await ensureNumberImportedToElevenLabs(supabase, newNumberId);
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
  // Connecting an agent to a campaign puts it into service — make sure its
  // ElevenLabs webhooks are current so completed calls report back to us.
  await reapplyAgentIntegration(supabase, payload.agent_id);
  await refreshAttachedSmartList(supabase, payload.smart_list_id);
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
  // The agent may have changed (or been wired before its webhook was set) —
  // refresh its ElevenLabs integration so calls report back to us.
  await reapplyAgentIntegration(supabase, payload.agent_id);
  await refreshAttachedSmartList(supabase, payload.smart_list_id);
  revalidatePath(CAMPAIGNS_PATH);
  return { error: null, campaignId: id };
}

/** Flip a campaign's Autopilot. Off = the AI auto-dialer ignores it, but the
 *  campaign stays active so manual Call Now keeps working. */
export async function setCampaignAutopilot(
  id: string,
  enabled: boolean,
): Promise<CampaignResult> {
  const { supabase, error: authError } = await requireAuth();
  if (authError) return { error: authError };

  const { error } = await supabase
    .from("campaigns")
    .update({ autopilot_enabled: enabled })
    .eq("id", id);
  if (error) return { error: "Could not update Autopilot." };

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

  // Reactivating puts the agent back into service — refresh its webhooks.
  const { data: camp } = await supabase
    .from("campaigns")
    .select("agent_id")
    .eq("id", id)
    .maybeSingle();
  await reapplyAgentIntegration(supabase, camp?.agent_id);

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

  // The clone is created active with the same agent — refresh its webhooks.
  await reapplyAgentIntegration(supabase, original.agent_id);

  revalidatePath(CAMPAIGNS_PATH);
  return { error: null, campaignId: created.id };
}

/** Flip a campaign's Smart Scheduling flag.
 *  On: retries aim for each lead's best-answering hour in their timezone.
 *  Off: retries fall back to the campaign's fixed calling-hours window. */
export async function setCampaignSmartScheduling(
  id: string,
  enabled: boolean,
): Promise<CampaignResult> {
  const { supabase, error: authError } = await requireAuth();
  if (authError) return { error: authError };

  const { error } = await supabase
    .from("campaigns")
    .update({ smart_scheduling: enabled })
    .eq("id", id);
  if (error) return { error: "Could not update Smart scheduling." };

  revalidatePath(CAMPAIGNS_PATH);
  return { error: null, campaignId: id };
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
