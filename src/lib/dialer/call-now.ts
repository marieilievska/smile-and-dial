"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import { placeLiveCall } from "@/lib/twilio/place-call";

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
  const twilioLive = process.env.TWILIO_LIVE === "live";
  const elevenLive = process.env.ELEVENLABS_LIVE === "live";
  // Round L3 — Twilio live dialing is now wired. ElevenLabs live still
  // needs L4 work (Connect → Stream against ElevenLabs Convai); if
  // someone flips both at once we fall through to the live Twilio
  // path with the L3 placeholder TwiML, which says "the agent will be
  // wired up next" and hangs up.
  void elevenLive;

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

  // Round L3 — fork: live Twilio dialing vs. mock-mode synthetic call.
  if (twilioLive) {
    if (!lead.business_phone) {
      return { error: "Lead has no phone number on file." };
    }
    if (!campaign.twilio_number_id) {
      return { error: "Campaign has no Twilio number assigned." };
    }
    const { data: twilioNumber } = await admin
      .from("twilio_numbers")
      .select("phone_number, released_at")
      .eq("id", campaign.twilio_number_id)
      .maybeSingle();
    if (!twilioNumber || twilioNumber.released_at) {
      return { error: "The campaign's Twilio number isn't available." };
    }

    // Insert the calls row first with status='queued' so the status
    // webhook has a row to find even if its first callback beats our
    // own update of `twilio_call_sid` here. We pass the row id back
    // to Twilio via the callback URL's `call_id` query param so the
    // status handler can resolve the row regardless of timing.
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
        outcome_source: "twilio",
      })
      .select("id")
      .single();
    if (pendingError || !pending) {
      return { error: "Could not record the call before dialing." };
    }

    const result = await placeLiveCall({
      callId: pending.id,
      from: twilioNumber.phone_number,
      to: lead.business_phone,
    });
    if (!result.ok) {
      // The row is left with status='queued' so it's visible in
      // /calls with a clear "never dialed" state. The status webhook
      // would never fire on it.
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
