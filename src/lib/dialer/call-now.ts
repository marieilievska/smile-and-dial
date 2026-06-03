"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";

import { resolveAndPlaceAgentCall } from "@/lib/dialer/agent-dial";
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
  campaign_not_active: "Campaign is paused or ended.",
  campaign_has_no_twilio_number: "Campaign has no Twilio number attached.",
  twilio_number_missing: "The campaign's Twilio number isn't available.",
  twilio_number_reassigned:
    "The Twilio number was reassigned to another campaign.",
  outside_calling_hours:
    "The lead's local time is outside calling hours for this campaign.",
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
    .select("id, list_id, owner_id, business_phone")
    .eq("id", input.leadId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!lead) return { error: "Lead not found." };

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

  // Use the service-role client so we don't trip RLS when stamping
  // fields the user doesn't directly own (status updates, costs).
  const admin = makeServiceClient();
  const startedAt = new Date();

  // Fork: live calling (ElevenLabs places + runs the call) vs. mock synthetic.
  if (liveCalling) {
    if (!lead.business_phone) {
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
      toNumber: lead.business_phone,
    });
    if (!result.ok) {
      await admin
        .from("calls")
        .update({ status: "failed", outcome: "failed" })
        .eq("id", pending.id);
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
