import "server-only";

import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

type SupabaseAdmin = ReturnType<typeof createClient<Database>>;

/** The `calls` row shape both ElevenLabs webhooks work from. */
export type InboundCallRow = {
  id: string;
  lead_id: string;
  campaign_id: string;
  cost_breakdown: unknown;
  elevenlabs_conversation_id: string | null;
  started_at: string | null;
  direction: string | null;
};

const CALL_COLS =
  "id, lead_id, campaign_id, cost_breakdown, elevenlabs_conversation_id, started_at, direction";

/**
 * Resolve (or create) the `calls` row for an ElevenLabs-NATIVE inbound call —
 * someone dialing one of our pool numbers, usually returning a missed call.
 *
 * Nothing on our side placed this call, so no row exists until we make one.
 * Two webhooks need the same row and the same lead attribution:
 *   - the conversation-init webhook, at the START of the call, so the agent
 *     gets the lead's context and a real `call_id` for its tools;
 *   - the post-call webhook, at the END, as a fallback when init never ran
 *     (older calls, an init timeout, a re-delivered event).
 * Keeping both on this one function is what stops them from attributing the
 * same call to two different leads.
 *
 * Steps: our number → its attached campaign (owner + agent). If a row already
 * carries this Twilio CallSid, reuse it (stamping the conversation id if it's
 * missing) — never clobber `started_at`. Otherwise caller → the owner's
 * matching lead, or a new lead in the owner's Inbound list, then insert the
 * row. The unique `twilio_call_sid` makes the insert race-safe.
 *
 * Returns null when the dialed number isn't one of ours / has no campaign, or
 * the CallSid is missing — i.e. this isn't an attributable inbound call.
 */
export async function resolveOrCreateInboundCall(
  supabase: SupabaseAdmin,
  input: {
    /** The pool number the caller dialed (ElevenLabs: called_number / agent_number). */
    agentNumber: string;
    /** The caller's number (ElevenLabs: caller_id / external_number). */
    callerNumber: string;
    /** Twilio CallSid — the one identifier both webhooks agree on. */
    callSid: string;
    conversationId: string | null;
  },
): Promise<InboundCallRow | null> {
  const agentNumber = input.agentNumber.trim();
  const callerNumber = input.callerNumber.trim();
  const callSid = input.callSid.trim();
  if (!agentNumber || !callSid) return null;

  // Our number → campaign (owner + agent). A number we don't own, or one with
  // no campaign, means this isn't ours to log.
  const { data: numberRow } = await supabase
    .from("twilio_numbers")
    .select("id, attached_campaign_id")
    .eq("phone_number", agentNumber)
    .maybeSingle();
  if (!numberRow?.attached_campaign_id) return null;

  // Already created (init ran, or a re-delivered event)? Reuse it as-is.
  const { data: existing } = await supabase
    .from("calls")
    .select(CALL_COLS)
    .eq("twilio_call_sid", callSid)
    .maybeSingle();
  if (existing) {
    const row = existing as InboundCallRow;
    if (input.conversationId && !row.elevenlabs_conversation_id) {
      await supabase
        .from("calls")
        .update({ elevenlabs_conversation_id: input.conversationId })
        .eq("id", row.id);
      row.elevenlabs_conversation_id = input.conversationId;
    }
    return row;
  }

  const { data: campaign } = await supabase
    .from("campaigns")
    .select("id, owner_id, agent_id")
    .eq("id", numberRow.attached_campaign_id)
    .maybeSingle();
  if (!campaign) return null;

  // Caller → lead: reuse the owner's matching lead, else create one in the
  // owner's Inbound list.
  //
  // People often return a missed call from a DIFFERENT number than the one we
  // dialed (their cell, a second line), so match on every phone column, not
  // just business_phone. A merged inbound lead parks the caller's number on
  // the destination's mobile_phone / owner_phone (merge_inbound_lead), so the
  // next call from that number lands on the right lead instead of spawning
  // another orphan. Soft-deleted leads (merged sources still carry the number)
  // are excluded; the business line is preferred on a tie.
  let leadId: string | null = null;
  if (callerNumber) {
    const { data: matches } = await supabase
      .from("leads")
      .select("id, business_phone")
      .eq("owner_id", campaign.owner_id)
      .is("deleted_at", null)
      .or(
        `business_phone.eq.${callerNumber},mobile_phone.eq.${callerNumber},owner_phone.eq.${callerNumber}`,
      )
      .order("created_at", { ascending: true })
      .limit(5);
    const existingLead =
      matches?.find((m) => m.business_phone === callerNumber) ?? matches?.[0];
    if (existingLead) leadId = existingLead.id;
  }
  if (!leadId) {
    const { data: listId } = await supabase.rpc("get_or_create_inbound_list", {
      in_owner: campaign.owner_id,
    });
    if (!listId) return null;
    const { data: newLead } = await supabase
      .from("leads")
      .insert({
        owner_id: campaign.owner_id,
        list_id: listId as string,
        business_phone: callerNumber || null,
        company: callerNumber || "Inbound caller",
      })
      .select("id")
      .single();
    if (!newLead) return null;
    leadId = newLead.id;
  }

  // Upsert on the unique CallSid: if init and post-call ever race, whichever
  // lands second reuses the first's row instead of failing.
  const { data: call } = await supabase
    .from("calls")
    .upsert(
      {
        lead_id: leadId,
        campaign_id: campaign.id,
        agent_id: campaign.agent_id,
        twilio_number_id: numberRow.id,
        direction: "inbound",
        status: "in_progress",
        twilio_call_sid: callSid,
        elevenlabs_conversation_id: input.conversationId,
        started_at: new Date().toISOString(),
      },
      { onConflict: "twilio_call_sid" },
    )
    .select(CALL_COLS)
    .maybeSingle();
  return (call as InboundCallRow | null) ?? null;
}
