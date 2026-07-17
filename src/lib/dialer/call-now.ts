"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";

import { ACTIVE_CALL_STATUSES } from "@/lib/calls/live-calls";
import { resolveAndPlaceAgentCall } from "@/lib/dialer/agent-dial";
import { closeStaleActiveCalls } from "@/lib/dialer/stale-calls";
import type { Database } from "@/lib/supabase/database.types";

type SupabaseAdmin = ReturnType<typeof createAdminClient<Database>>;

function makeServiceClient(): SupabaseAdmin {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    throw new Error(
      "Call Now requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.",
    );
  }
  return createAdminClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

const PRE_CALL_REASON_LABELS: Record<string, string> = {
  lead_missing_or_deleted: "Lead is missing or deleted.",
  lead_has_no_phone: "Lead has no phone number.",
  lead_on_dnc: "This number is on the DNC list.",
  lead_is_mobile:
    "This is a mobile number — Smile & Dial doesn't auto-dial cell phones.",
  call_in_flight: "This lead already has a call in progress.",
  campaign_not_active: "Campaign is paused or ended.",
  campaign_has_no_twilio_number: "Campaign has no Twilio number attached.",
  twilio_number_missing: "The campaign's Twilio number isn't available.",
  twilio_number_reassigned:
    "The Twilio number was reassigned to another campaign.",
  outside_calling_hours:
    "The lead's local time is outside calling hours for this campaign.",
  pacing_wait:
    "Another call for this campaign was just placed — try again in a few seconds.",
  hourly_cap_hit: "The campaign hit its hourly call cap.",
  daily_cap_hit: "The campaign hit its daily call cap.",
  concurrency_cap_hit: "You're at your concurrent-call cap.",
  daily_spend_cap_hit: "The campaign hit its daily spend cap.",
  monthly_spend_cap_hit: "The campaign hit its monthly spend cap.",
};

export type CallNowResult = { error: string | null; callId?: string };

/**
 * Fire one immediate dial on a specific (lead, campaign) pair from the
 * lead-detail "Call Now" button. Still runs pre_call_check so DNC,
 * calling hours, caps, and concurrency are all respected.
 *
 * Mock mode (default) inserts a believable `completed` call row with a
 * fixed outcome ("no_answer") so the rest of the system sees a real
 * call landing — Twilio + ElevenLabs are wired off until live mode is
 * approved.
 */
export async function callNow(input: {
  leadId: string;
  campaignId: string;
  /** Which of the lead's two numbers to dial. Defaults to the business line.
   *  "owner" dials the owner's direct line (from the lead-detail owner call
   *  control) and adds a DNC check on that specific number. */
  target?: "business" | "owner";
}): Promise<CallNowResult> {
  // Live calling now runs through ElevenLabs' native Twilio integration:
  // ElevenLabs places the call and owns the media. Gate on ELEVENLABS_LIVE.
  const liveCalling = process.env.ELEVENLABS_LIVE === "live";

  // Authenticate via the user-scoped client so RLS guards the request.
  const userClient = await createClient();
  const {
    data: { user },
  } = await userClient.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  // The user has to actually own the lead (or be admin) — RLS will block
  // a stranger from reading it. Same for the campaign. Round L3 — we
  // also pull business_phone so the live Twilio path knows where to
  // dial; mock mode never used it, but the live placeCall helper does.
  const { data: lead } = await userClient
    .from("leads")
    .select("id, list_id, owner_id, business_phone, owner_phone")
    .eq("id", input.leadId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!lead) return { error: "Lead not found." };

  // Which number to dial. Default is the business line; "owner" dials the
  // owner's direct line. Validate the owner number exists up front so the
  // user gets a clear message instead of a generic placement failure.
  const dialTarget: "business" | "owner" =
    input.target === "owner" ? "owner" : "business";
  const dialNumber =
    dialTarget === "owner" ? lead.owner_phone : lead.business_phone;
  if (dialTarget === "owner" && !lead.owner_phone) {
    return { error: "This lead has no owner phone number on file." };
  }

  const { data: campaign } = await userClient
    .from("campaigns")
    .select("id, agent_id, twilio_number_id")
    .eq("id", input.campaignId)
    .maybeSingle();
  if (!campaign) return { error: "Campaign not found." };

  // The lead's list must be actively attached to the campaign.
  const { data: attachment } = await userClient
    .from("list_campaign_attachments")
    .select("id")
    .eq("list_id", lead.list_id)
    .eq("campaign_id", input.campaignId)
    .is("detached_at", null)
    .maybeSingle();
  if (!attachment) {
    return {
      error:
        "That campaign isn't attached to this lead's list. Attach it from the campaign settings first.",
    };
  }

  // Reap any calls stuck in-flight past the max window first, so a dropped
  // post-call webhook can't block this dial on the concurrency cap.
  await closeStaleActiveCalls(makeServiceClient());

  // The pre-call check is the same one the cron uses. Returns null when safe.
  // Fail CLOSED: if the RPC itself errors we must NOT dial — a thrown
  // pre_call_check would otherwise leave `reason` null and silently bypass
  // every gate (DNC, calling hours, caps, concurrency).
  const { data: reason, error: preCallError } = await userClient.rpc(
    "pre_call_check",
    {
      in_lead_id: input.leadId,
      in_campaign_id: input.campaignId,
    },
  );
  if (preCallError) {
    return {
      error: "Couldn't run the pre-call safety check. Please try again.",
    };
  }
  if (reason) {
    return {
      error:
        PRE_CALL_REASON_LABELS[reason as string] ??
        `Pre-call check failed: ${reason}`,
    };
  }

  // pre_call_check only screens the business line against the DNC list. An
  // owner call dials a different number, so screen THAT number too — calling a
  // decision-maker's personal cell after they asked us not to is exactly what
  // DNC is for.
  if (dialTarget === "owner") {
    const { data: ownerOnDnc } = await userClient.rpc("is_phone_on_dnc", {
      phone_to_check: dialNumber as string,
    });
    if (ownerOnDnc) {
      return { error: "The owner's number is on the DNC list." };
    }
  }

  // Use the service-role client so we don't trip RLS when stamping
  // fields the user doesn't directly own (status updates, costs).
  const admin = makeServiceClient();
  const startedAt = new Date();

  // Guard against a double-dial. pre_call_check screened for an in-flight call
  // earlier, but between that check and the insert below a second Call Now (a
  // double-click, another operator) or the autopilot tick could place one —
  // pre_call_check runs before either side inserts its calls row, so it can't
  // see a sibling that's mid-flight. Re-check for an active call against the
  // service client immediately before inserting so we never put two
  // simultaneous live calls on the same business (wasted spend + a TCPA
  // harassment pattern). This narrows the window to sub-millisecond; a
  // partial-unique index on calls(lead_id) for active statuses would close it
  // entirely at the DB level.
  const { data: activeCalls } = await admin
    .from("calls")
    .select("id")
    .eq("lead_id", input.leadId)
    .in("status", ACTIVE_CALL_STATUSES as unknown as string[])
    .limit(1);
  if (activeCalls && activeCalls.length > 0) {
    return { error: "This lead already has a call in progress." };
  }

  // Claim ownership for this campaign BEFORE placing the call (guarded so it
  // never steals an already-owned lead). Doing this pre-dial is what lets a
  // concurrent autopilot tick's claim_lead_for_dial see the owner and refuse —
  // stamping after the dial would leave a window for a cross-campaign double
  // call. Rolled back below if a live placement fails.
  await admin
    .from("leads")
    .update({ owner_campaign_id: input.campaignId })
    .eq("id", input.leadId)
    .is("owner_campaign_id", null);

  // Fork: live calling (ElevenLabs places + runs the call) vs. mock synthetic.
  if (liveCalling) {
    if (!dialNumber) {
      return { error: "Lead has no phone number on file." };
    }
    if (!campaign.twilio_number_id) {
      return { error: "Campaign has no Twilio number assigned." };
    }

    // Insert the calls row first (status='dialing') so the post-call webhook
    // has a row to find. We pass the row id to ElevenLabs as the call_id
    // dynamic variable; it's echoed back in the post-call webhook so that
    // handler resolves this row deterministically.
    const { data: pending, error: pendingError } = await admin
      .from("calls")
      .insert({
        lead_id: input.leadId,
        campaign_id: input.campaignId,
        agent_id: campaign.agent_id,
        twilio_number_id: campaign.twilio_number_id,
        direction: "outbound",
        status: "queued",
        outcome: null,
        outcome_source: "elevenlabs",
        dialed_target: dialTarget === "owner" ? "owner" : null,
      })
      .select("id")
      .single();
    if (pendingError || !pending) {
      return { error: "Could not record the call before dialing." };
    }

    const result = await resolveAndPlaceAgentCall(admin, {
      callId: pending.id,
      agentId: campaign.agent_id,
      twilioNumberId: campaign.twilio_number_id,
      toNumber: dialNumber,
    });
    if (!result.ok) {
      await admin
        .from("calls")
        .update({ status: "failed", outcome: "failed" })
        .eq("id", pending.id);
      // The dial didn't go out — release the ownership we optimistically stamped
      // (only if it's still ours), so a failed manual dial doesn't lock the lead.
      await admin
        .from("leads")
        .update({ owner_campaign_id: null })
        .eq("id", input.leadId)
        .eq("owner_campaign_id", input.campaignId);
      return { error: result.error };
    }

    await admin
      .from("calls")
      .update({
        twilio_call_sid: result.twilioCallSid,
        elevenlabs_conversation_id: result.conversationId,
        started_at: startedAt.toISOString(),
        status: "dialing",
      })
      .eq("id", pending.id);

    // Bump the lead so the queue doesn't re-pick it immediately.
    await admin
      .from("leads")
      .update({
        last_call_at: startedAt.toISOString(),
        next_call_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      })
      .eq("id", input.leadId);

    await admin.from("system_events").insert({
      kind: "call_now",
      actor_user_id: user.id,
      ref_table: "calls",
      ref_id: pending.id,
      payload: {
        lead_id: input.leadId,
        campaign_id: input.campaignId,
        twilio_call_sid: result.twilioCallSid,
        mode: "live",
      },
    });

    revalidatePath("/leads");
    revalidatePath("/calls");
    return { error: null, callId: pending.id };
  }

  // Mock-mode (default) — insert a believable `completed` call row
  // with a fixed outcome so the rest of the system sees a real call
  // landing without touching Twilio or ElevenLabs.
  const durationSeconds = 30;
  const { data: call, error: callError } = await admin
    .from("calls")
    .insert({
      lead_id: input.leadId,
      campaign_id: input.campaignId,
      agent_id: campaign.agent_id,
      twilio_number_id: campaign.twilio_number_id,
      direction: "outbound",
      status: "completed",
      outcome: "no_answer",
      outcome_source: "twilio",
      dialed_target: dialTarget === "owner" ? "owner" : null,
      started_at: startedAt.toISOString(),
      ended_at: new Date(
        startedAt.getTime() + durationSeconds * 1000,
      ).toISOString(),
      duration_seconds: durationSeconds,
      talk_time_seconds: 0,
      cost_breakdown: {
        twilio: 0.02,
        elevenlabs: 0,
        openai: 0,
        lookup: 0,
        total: 0.02,
      },
    })
    .select("id")
    .single();
  if (callError || !call) {
    return { error: "Could not place the call." };
  }

  // Bump the lead so the dialer queue doesn't re-pick it immediately.
  await admin
    .from("leads")
    .update({
      last_call_at: startedAt.toISOString(),
      next_call_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    })
    .eq("id", input.leadId);

  await admin.from("system_events").insert({
    kind: "call_now",
    actor_user_id: user.id,
    ref_table: "calls",
    ref_id: call.id,
    payload: { lead_id: input.leadId, campaign_id: input.campaignId },
  });

  revalidatePath("/leads");
  revalidatePath("/calls");
  return { error: null, callId: call.id };
}

export type CallNowFromLeadResult = {
  error: string | null;
  callId?: string;
  /** True when the lead's list is attached to more than one active campaign and
   *  no saved preference picks one — the caller should open the lead's Call
   *  dialog so the user can choose. */
  needsPicker?: boolean;
};

/**
 * One-click "Call now" from the Leads list: resolve which campaign to dial with
 * (the user's active-campaign preference if it's valid for this lead, otherwise
 * the lead's list's single active campaign) and fire `callNow` — no navigation.
 * When the campaign can't be resolved unambiguously we return `needsPicker` so
 * the row can fall back to opening the lead's Call dialog.
 */
export async function callNowFromLead(
  leadId: string,
  target: "business" | "owner" = "business",
): Promise<CallNowFromLeadResult> {
  const userClient = await createClient();
  const {
    data: { user },
  } = await userClient.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { data: lead } = await userClient
    .from("leads")
    .select("id, list_id, owner_campaign_id")
    .eq("id", leadId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!lead) return { error: "Lead not found." };

  // If this lead is already owned, it belongs to that campaign — dial under it
  // (ownership is released on detach/delete, so a set owner is always valid).
  if (lead.owner_campaign_id) {
    return callNow({ leadId, campaignId: lead.owner_campaign_id, target });
  }

  // Active campaigns attached to this lead's list (same query the detail page
  // uses to populate the Call dialog).
  const { data: campaignRows } = await userClient
    .from("list_campaign_attachments")
    .select("campaign:campaigns(id, status)")
    .eq("list_id", lead.list_id)
    .is("detached_at", null);
  type Row = { campaign: { id: string; status: string } | null };
  const activeCampaignIds = ((campaignRows ?? []) as unknown as Row[])
    .map((r) => r.campaign)
    .filter((c): c is { id: string; status: string } => Boolean(c))
    .filter((c) => c.status === "active")
    .map((c) => c.id);

  if (activeCampaignIds.length === 0) {
    return {
      error:
        "No active campaign is attached to this lead's list. Attach one from Campaigns first.",
    };
  }

  // Prefer the user's saved active-campaign when it's valid for this lead;
  // otherwise only auto-pick when there's exactly one choice.
  const { data: profile } = await userClient
    .from("profiles")
    .select("active_campaign_id")
    .eq("id", user.id)
    .maybeSingle();
  const preferred = profile?.active_campaign_id;
  let campaignId: string | null = null;
  if (preferred && activeCampaignIds.includes(preferred)) {
    campaignId = preferred;
  } else if (activeCampaignIds.length === 1) {
    campaignId = activeCampaignIds[0];
  }
  if (!campaignId) {
    // Multiple campaigns and no saved preference — let the user choose.
    return { error: null, needsPicker: true };
  }

  return callNow({ leadId, campaignId, target });
}
