"use server";

import { revalidatePath } from "next/cache";

import type { ToolsEnabled } from "@/lib/agents/prompt";
import { sanitizeAudienceSearch } from "@/lib/campaigns/audience-filter";
import { applyConnectedAgentIntegration } from "@/lib/elevenlabs/agents";
import { createAdminClient as createServiceClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  assignAgentToNumber,
  ensureNumberImportedToElevenLabs,
} from "@/lib/twilio/place-call";

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
  /** Minimum seconds between this campaign's cold dials, so the dialer spaces
   *  calls out instead of firing the whole concurrency allotment at once.
   *  "0"/empty = no pacing (dial as fast as the caps allow). Optional. */
  dialIntervalSeconds?: string;
  transferDestinationPhone: string;
  dailySpendCap: string;
  monthlySpendCap: string;
  /** When false the AI auto-dialer skips this campaign; manual Call Now still
   *  works. Optional so existing call sites default it to on. */
  autopilotEnabled?: boolean;
  /** When true, retries aim for each lead's best-answering hour (in their
   *  timezone) instead of a fixed time window. Optional, defaults to false. */
  smartSchedulingEnabled?: boolean;
  doubleCallEnabled?: boolean;
  /** Calendly event type (calendly_event_types.id) the booking tools check
   *  availability against and book into. Empty = booking is OFF for this
   *  campaign (the agent won't offer times or book; no fallback event). */
  calendlyEventId?: string;
  /** Fixed-time event (webinar): book the Calendly event's soonest opening
   *  without the lead choosing a time, so book_appointment works from name +
   *  email alone. Needs a calendlyEventId. Optional, defaults to false. */
  fixedTimeBooking?: boolean;
  /** Email template (email_templates.id) the send_email tool sends. Empty =
   *  no template, the tool only records intent. */
  emailTemplateId?: string;
  /** SMS template (sms_templates.id) the send_text tool sends. Empty = no
   *  template, the tool only records intent. */
  smsTemplateId?: string;
  /** Optional company-name "contains" filter. When set, the campaign also
   *  targets every lead (same owner) whose company name contains this text,
   *  regardless of list. Empty = list-only targeting. */
  audienceSearch?: string;
  /** Optional attached smart list id (smart_lists.id). When set, the campaign
   *  also dials every member of that smart list. Empty = no smart list. */
  smartListId?: string;
  /** First line the agent speaks on an INBOUND call to this campaign's number.
   *  Delivered to ElevenLabs per-call by the conversation-init webhook. Empty =
   *  the webhook's default greeting (so inbound is never silent). */
  inboundGreeting?: string;
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
    // Ceiling is the ElevenLabs workspace concurrency limit — no point allowing
    // a value EL can't honor. 30 on the current Scale ("growing_business")
    // plan, raised from 20 on Pro (2026-08-03). Shared workspace-wide INCLUDING
    // inbound, so setting a campaign to the full 30 leaves inbound nothing;
    // that is deliberately the operator's call, not a clamp.
    //
    // Enforcement is owner-wide, not per campaign: pre_call_check counts ALL of
    // the owner's live calls against whichever campaign it is checking. Two
    // campaigns set to 30 therefore share ONE 30-call budget, and a campaign
    // left at a lower value is capped at that lower value even when the other
    // has room — so set this consistently across an owner's campaigns.
    //
    // Three gates must move together when the plan changes: this clamp, the
    // input max in campaign-settings-dialog.tsx, and the
    // campaigns_concurrency_cap_per_user_check DB constraint.
    concurrency_cap_per_user: Math.min(
      30,
      Math.max(1, parseNumber(input.concurrencyCapPerUser) ?? 2),
    ),
    // Seconds between cold dials (0 = off). Clamped to a sane 0–120s.
    dial_interval_seconds: Math.min(
      120,
      Math.max(0, parseNumber(input.dialIntervalSeconds ?? "") ?? 0),
    ),
    transfer_destination_phone: input.transferDestinationPhone.trim() || null,
    daily_spend_cap: parseNumber(input.dailySpendCap),
    monthly_spend_cap: parseNumber(input.monthlySpendCap),
    autopilot_enabled: input.autopilotEnabled ?? true,
    smart_scheduling: input.smartSchedulingEnabled ?? false,
    double_call_enabled: input.doubleCallEnabled ?? false,
    calendly_event_id: input.calendlyEventId?.trim() || null,
    fixed_time_booking: input.fixedTimeBooking ?? false,
    email_template_id: input.emailTemplateId?.trim() || null,
    sms_template_id: input.smsTemplateId?.trim() || null,
    audience_search: sanitizeAudienceSearch(input.audienceSearch ?? "") || null,
    smart_list_id: input.smartListId?.trim() || null,
    inbound_greeting: input.inboundGreeting?.trim() || null,
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
    const imported = await ensureNumberImportedToElevenLabs(
      supabase,
      newNumberId,
    );
    // Inbound is ElevenLabs-native: the agent that answers a number is the one
    // assigned to it in ElevenLabs. Assign this campaign's agent so callbacks to
    // the number reach the right agent — no manual step in the EL dashboard.
    if (imported.ok) {
      await assignCampaignAgentToNumber(
        supabase,
        campaignId,
        imported.phoneNumberId,
      );
    }
  }
}

/** Assign the campaign's agent to its ElevenLabs phone number so inbound calls
 *  to that number are answered by the right agent (EL-native inbound). Reads the
 *  campaign's agent → its published elevenlabs_agent_id; skips quietly if the
 *  agent isn't synced yet. Best-effort: a hiccup never blocks the campaign save
 *  (re-saving, or the per-number Connect button, re-asserts it). */
async function assignCampaignAgentToNumber(
  supabase: Awaited<ReturnType<typeof createClient>>,
  campaignId: string,
  elevenlabsPhoneNumberId: string,
): Promise<void> {
  const { data: campaign } = await supabase
    .from("campaigns")
    .select("agent_id")
    .eq("id", campaignId)
    .maybeSingle();
  if (!campaign?.agent_id) return;
  const { data: agent } = await supabase
    .from("agents")
    .select("elevenlabs_agent_id")
    .eq("id", campaign.agent_id)
    .maybeSingle();
  if (!agent?.elevenlabs_agent_id) return;
  try {
    await assignAgentToNumber(
      elevenlabsPhoneNumberId,
      agent.elevenlabs_agent_id,
    );
  } catch {
    // best-effort — never block a campaign action on an ElevenLabs hiccup
  }
}

/** Create a campaign. New campaigns are DRAFTS by default and don't dial until
 *  launched; pass `launch: true` ("Save & launch") to create it live in one step. */
export async function createCampaign(
  input: CampaignInput,
  launch = false,
): Promise<CampaignResult> {
  if (!input.name.trim()) return { error: "Give the campaign a name." };
  if (!input.agentId) return { error: "Pick an agent." };
  if (!input.goalId) return { error: "Pick a goal." };

  const { supabase, userId, error: authError } = await requireAuth();
  if (authError) return { error: authError };

  const payload = buildUpdate(input);
  const status = launch ? "active" : "draft";
  const { data: created, error } = await supabase
    .from("campaigns")
    .insert({ owner_id: userId!, status, ...payload })
    .select("id")
    .single();
  if (error || !created) return { error: "Could not create the campaign." };

  await syncTwilioAttachment(
    supabase,
    created.id,
    payload.twilio_number_id,
    null,
  );
  // Going live puts the agent into service — refresh its ElevenLabs webhooks so
  // completed calls report back to us. A draft doesn't dial, so that's deferred
  // to launchCampaign.
  if (launch) await reapplyAgentIntegration(supabase, payload.agent_id);
  await refreshAttachedSmartList(supabase, payload.smart_list_id);
  revalidatePath(CAMPAIGNS_PATH);
  return { error: null, campaignId: created.id };
}

/** Launch a draft campaign — draft → active. It starts dialing on the next
 *  dialer tick (respecting calling hours + autopilot). Only a draft can be
 *  launched; a paused campaign uses resume. */
export async function launchCampaign(id: string): Promise<CampaignResult> {
  const { supabase, userId, error: authError } = await requireAuth();
  if (authError) return { error: authError };

  const { data: camp } = await supabase
    .from("campaigns")
    .select("status, agent_id")
    .eq("id", id)
    .maybeSingle();
  if (!camp) return { error: "That campaign no longer exists." };
  if (camp.status !== "draft") {
    return { error: "Only a draft campaign can be launched." };
  }

  const { error } = await supabase
    .from("campaigns")
    .update({ status: "active" })
    .eq("id", id);
  if (error) return { error: "Could not launch the campaign." };

  // Now it's live — refresh the agent's webhooks (deferred from create).
  await reapplyAgentIntegration(supabase, camp.agent_id);

  await supabase.from("system_events").insert({
    kind: "campaign_launched",
    actor_user_id: userId,
    ref_table: "campaigns",
    ref_id: id,
    payload: {},
  });

  revalidatePath(CAMPAIGNS_PATH);
  return { error: null, campaignId: id };
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

/** The user's other campaigns a source could be merged INTO (non-ended). */
export async function listMergeTargets(
  excludeId: string,
): Promise<{ id: string; name: string; status: string }[]> {
  const { supabase, error } = await requireAuth();
  if (error) return [];
  const { data } = await supabase
    .from("campaigns")
    .select("id, name, status")
    .neq("id", excludeId)
    .neq("status", "ended")
    .order("name");
  return (data ?? []).map((c) => ({
    id: c.id,
    name: c.name ?? "(untitled)",
    status: c.status ?? "",
  }));
}

/**
 * Fold a source campaign's whole footprint into a target, then end the source.
 * Moves lead ownership, list attachments, callbacks, per-campaign summaries, and
 * phone numbers; call history stays with the source (its per-campaign reporting
 * stays accurate). The atomic reassignment runs in the merge_campaign() Postgres
 * function; here we verify the caller OWNS both campaigns (RLS-scoped read)
 * before invoking it via the service role (the function is service_role-only).
 */
export async function mergeCampaign(input: {
  sourceId: string;
  targetId: string;
}): Promise<CampaignResult> {
  const { supabase, error: authError } = await requireAuth();
  if (authError) return { error: authError };
  if (input.sourceId === input.targetId) {
    return { error: "Pick two different campaigns." };
  }
  // Ownership gate: the RLS-scoped client must see BOTH campaigns.
  const { data: owned } = await supabase
    .from("campaigns")
    .select("id, status")
    .in("id", [input.sourceId, input.targetId]);
  if (!owned || owned.length !== 2) {
    return { error: "You can only merge campaigns you own." };
  }
  if (owned.find((c) => c.id === input.targetId)?.status === "ended") {
    return { error: "The target campaign has ended — pick an active one." };
  }

  const admin = createServiceClient();
  const { error } = await admin.rpc("merge_campaign", {
    p_source: input.sourceId,
    p_target: input.targetId,
  });
  if (error) return { error: "Could not merge the campaigns." };

  revalidatePath(CAMPAIGNS_PATH);
  revalidatePath("/settings/lists");
  revalidatePath("/leads");
  return { error: null, campaignId: input.targetId };
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
      "name, description, agent_id, goal_id, calling_hours_start, calling_hours_end, calls_per_hour_cap, calls_per_day_cap, concurrency_cap_per_user, dial_interval_seconds, transfer_destination_phone, daily_spend_cap, monthly_spend_cap",
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
      dial_interval_seconds: original.dial_interval_seconds,
      transfer_destination_phone: original.transfer_destination_phone,
      daily_spend_cap: original.daily_spend_cap,
      monthly_spend_cap: original.monthly_spend_cap,
      // Clones are DRAFTS — you review the copy and launch it deliberately,
      // like any new campaign, rather than it dialing the moment you clone.
      status: "draft",
    })
    .select("id")
    .single();
  if (error || !created) return { error: "Could not clone the campaign." };

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
