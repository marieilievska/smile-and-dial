import { createClient } from "@supabase/supabase-js";

import { selectPoolNumber } from "@/lib/dialer/number-pool";
import { syncLeadCallCounters } from "@/lib/leads/call-counters";
import type { Database } from "@/lib/supabase/database.types";
import { rankHumanCallCampaigns } from "@/lib/twilio/human-call-policy";

type SupabaseAdmin = ReturnType<typeof createClient<Database>>;

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Build the TwiML that bridges the browser caller to the lead with recording
 *  enabled. `record-from-answer-dual` records both legs once the lead answers.
 *  The recording callback fires our /api/twilio/recording handler ONLY when the
 *  lead answers. The Dial `action` callback fires when the dial finishes for
 *  ANY reason (answered, no-answer, busy, failed), carrying DialCallStatus +
 *  DialCallDuration — that's what terminalizes every human call, including the
 *  ones the lead never picked up. */
export function buildDialTwiml(opts: {
  leadPhone: string;
  callerId: string;
  appBaseUrl: string;
}): string {
  const recordingCb = `${opts.appBaseUrl}/api/twilio/recording`;
  const completeCb = `${opts.appBaseUrl}/api/twilio/voice-browser-dial/complete`;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Dial callerId="${xmlEscape(opts.callerId)}" answerOnBridge="true" ` +
    `action="${xmlEscape(completeCb)}" method="POST" ` +
    `record="record-from-answer-dual" ` +
    `recordingStatusCallback="${xmlEscape(recordingCb)}" ` +
    `recordingStatusCallbackEvent="completed">` +
    `<Number>${xmlEscape(opts.leadPhone)}</Number>` +
    `</Dial>` +
    `</Response>`
  );
}

/** The lead fields a human dial needs: who owns it (authorisation), its stage
 *  (a 'dnc' lead is never dialed), the two numbers, and its list / owning
 *  campaign (caller-ID resolution). */
export type HumanCallLead = {
  id: string;
  owner_id: string;
  status: string;
  business_phone: string | null;
  owner_phone: string | null;
  list_id: string | null;
  owner_campaign_id: string | null;
};

export async function loadHumanCallLead(
  supabase: SupabaseAdmin,
  leadId: string,
): Promise<HumanCallLead | null> {
  const { data } = await supabase
    .from("leads")
    .select(
      "id, owner_id, status, business_phone, owner_phone, list_id, owner_campaign_id",
    )
    .eq("id", leadId)
    .maybeSingle();
  return data ?? null;
}

export type HumanCallTarget = {
  leadPhone: string;
  callerId: string;
  campaignId: string;
  twilioNumberId: string;
  /** Which of the lead's numbers this resolved to, stamped on the call row. */
  dialedTarget: "business" | "owner";
};

/** Who is dialing, for campaign scoping: members may only borrow a caller ID
 *  from their own campaigns; admins from any. */
export type HumanCallScope = { userId: string; isAdmin: boolean };

/** A number's E.164 string, or null when it is unknown or has been released. */
async function poolNumberPhone(
  supabase: SupabaseAdmin,
  numberId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("twilio_numbers")
    .select("phone_number")
    .eq("id", numberId)
    .is("released_at", null)
    .maybeSingle();
  return data?.phone_number ?? null;
}

/**
 * Resolve where a human call to `lead` should go: the chosen phone (business
 * line by default, or the owner's direct line when `target` is "owner"), an
 * active campaign attached to the lead's list that the caller may use, and a
 * caller ID from that campaign's number pool.
 *
 * The caller ID comes from the SAME pool selector the AI dialer uses
 * (selectPoolNumber), so a human call honours rested / flagged / released
 * numbers and spreads load like an AI call would. The legacy single-number
 * column (campaigns.twilio_number_id) is only a fallback for a campaign whose
 * pool yields nothing — the pool UI clears that column when a number moves, so
 * requiring it (as this used to) failed every pool-managed campaign with "no
 * phone number to call from".
 *
 * Returns null when the lead has no such number, or no visible active campaign
 * has a usable number.
 */
export async function resolveHumanCallTarget(
  supabase: SupabaseAdmin,
  lead: HumanCallLead,
  target: "business" | "owner",
  scope: HumanCallScope,
): Promise<HumanCallTarget | null> {
  if (!lead.list_id) return null;
  const leadPhone = target === "owner" ? lead.owner_phone : lead.business_phone;
  if (!leadPhone) return null;

  const { data: attach } = await supabase
    .from("list_campaign_attachments")
    .select("campaign_id")
    .eq("list_id", lead.list_id)
    .is("detached_at", null);
  if (!attach || attach.length === 0) return null;

  const campaignIds = attach.map((a) => a.campaign_id);

  const { data: campaigns } = await supabase
    .from("campaigns")
    .select("id, owner_id, twilio_number_id")
    .in("id", campaignIds)
    .eq("status", "active");
  const ranked = rankHumanCallCampaigns(campaigns ?? [], {
    userId: scope.userId,
    isAdmin: scope.isAdmin,
    preferredCampaignId: lead.owner_campaign_id,
  });
  if (ranked.length === 0) return null;

  // Pool first — the lead's owning campaign gets the first pick.
  for (const campaign of ranked) {
    const picked = await selectPoolNumber(
      supabase,
      campaign.id,
      leadPhone,
      lead.id, // stable spread key, mirroring Call Now and the tick
    );
    if (!picked) continue;
    const callerId = await poolNumberPhone(supabase, picked.numberId);
    if (!callerId) continue;
    return {
      leadPhone,
      callerId,
      campaignId: campaign.id,
      twilioNumberId: picked.numberId,
      dialedTarget: target,
    };
  }

  // Legacy fallback: a campaign still carrying the single-number pointer.
  for (const campaign of ranked) {
    if (!campaign.twilio_number_id) continue;
    const callerId = await poolNumberPhone(supabase, campaign.twilio_number_id);
    if (!callerId) continue;
    return {
      leadPhone,
      callerId,
      campaignId: campaign.id,
      twilioNumberId: campaign.twilio_number_id,
      dialedTarget: target,
    };
  }

  return null;
}

/** Create the calls row for a human call and return its id. Also bumps the
 *  lead like every other dial path does: last_call_at moves to now and the
 *  Attempts / Conversations counters are recomputed from the calls table
 *  (syncLeadCallCounters is the one place they are derived — a human call that
 *  skipped it left the lead one attempt short). */
export async function createHumanCallRow(
  supabase: SupabaseAdmin,
  input: {
    leadId: string;
    campaignId: string;
    twilioNumberId: string;
    placedBy: string;
    /** The parent call leg's SID from Twilio's POST to voice-browser-dial.
     *  Stored so the Dial-completion and recording callbacks can correlate
     *  this exact row by CallSid instead of "most recent human call". */
    callSid?: string | null;
    /** Which number was dialed, for the "→ Owner" marker. */
    dialedTarget?: "business" | "owner";
  },
): Promise<string | null> {
  const startedAt = new Date().toISOString();
  const { data, error } = await supabase
    .from("calls")
    .insert({
      lead_id: input.leadId,
      campaign_id: input.campaignId,
      twilio_number_id: input.twilioNumberId,
      direction: "outbound",
      status: "dialing",
      call_mode: "human",
      placed_by: input.placedBy,
      outcome_source: "manual",
      twilio_call_sid: input.callSid ?? null,
      dialed_target: input.dialedTarget === "owner" ? "owner" : null,
      started_at: startedAt,
    })
    .select("id")
    .single();
  if (error || !data) return null;

  await supabase
    .from("leads")
    .update({ last_call_at: startedAt })
    .eq("id", input.leadId);
  await syncLeadCallCounters(supabase, input.leadId);

  return data.id;
}
