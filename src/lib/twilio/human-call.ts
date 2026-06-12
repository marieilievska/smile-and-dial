import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

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

export type HumanCallTarget = {
  leadPhone: string;
  callerId: string;
  campaignId: string;
  twilioNumberId: string;
  /** Which of the lead's numbers this resolved to, stamped on the call row. */
  dialedTarget: "business" | "owner";
};

/**
 * Resolve where a human call to `leadId` should go: the chosen phone (business
 * line by default, or the owner's direct line when `target` is "owner"), the
 * campaign that owns the lead's list, and that campaign's Twilio number (caller
 * ID). Returns null when the lead has no such number or no active campaign with
 * a usable number.
 */
export async function resolveHumanCallTarget(
  supabase: SupabaseAdmin,
  leadId: string,
  target: "business" | "owner" = "business",
): Promise<HumanCallTarget | null> {
  const { data: lead } = await supabase
    .from("leads")
    .select("business_phone, owner_phone, list_id")
    .eq("id", leadId)
    .maybeSingle();
  if (!lead?.list_id) return null;
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
    .select("id, twilio_number_id, status")
    .in("id", campaignIds)
    .eq("status", "active")
    .not("twilio_number_id", "is", null);
  const campaign = (campaigns ?? []).find((c) => c.twilio_number_id !== null);
  if (!campaign?.twilio_number_id) return null;

  const { data: num } = await supabase
    .from("twilio_numbers")
    .select("phone_number")
    .eq("id", campaign.twilio_number_id)
    .maybeSingle();
  if (!num?.phone_number) return null;

  return {
    leadPhone,
    callerId: num.phone_number,
    campaignId: campaign.id,
    twilioNumberId: campaign.twilio_number_id,
    dialedTarget: target,
  };
}

/** Create the calls row for a human call and return its id. */
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
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error || !data) return null;
  return data.id;
}
