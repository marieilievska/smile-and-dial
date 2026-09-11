import "server-only";

import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

type SupabaseAdmin = ReturnType<typeof createClient<Database>>;

export type BlockedInbound =
  | { blocked: true; campaignId: string; ownerId: string }
  | { blocked: false };

const NOT_BLOCKED: BlockedInbound = { blocked: false };

/**
 * Is this inbound caller blocked for the number they dialed?
 *
 * Answered BEFORE we create a lead or a `calls` row, so a blocked caller costs
 * nothing: no orphan Inbound lead, no ElevenLabs conversation, no credits. On
 * 2026-09-11 a single nuisance caller made 40 calls totalling ~124 minutes to
 * one pool number, and releasing that number — 32 hours after it was bought and
 * warmed up — was the only lever available.
 *
 * Blocking reuses the DNC list rather than inventing a second one, so the
 * existing "Mark do-not-call" on a lead is the block button: for an inbound
 * caller the lead's `business_phone` IS their number.
 *
 * DNC has been ENFORCED PER PERSON since 20260906020000, so the entry must
 * belong to the dialed number's CAMPAIGN OWNER — a teammate's list must not
 * silence this owner's callers. Same owner-scoped lookup book_appointment does.
 *
 * FAILS OPEN, deliberately. A number that isn't ours, a number with no
 * campaign, a withheld caller id, or a failed query all return
 * `blocked: false`. Hanging up on a real customer because a query hiccuped is
 * far worse than letting one nuisance call through.
 */
export async function resolveBlockedInbound(
  supabase: SupabaseAdmin,
  input: { agentNumber: string; callerNumber: string },
): Promise<BlockedInbound> {
  const agentNumber = input.agentNumber.trim();
  const callerNumber = input.callerNumber.trim();
  if (!agentNumber || !callerNumber) return NOT_BLOCKED;

  const { data: numberRow } = await supabase
    .from("twilio_numbers")
    .select("attached_campaign_id")
    .eq("phone_number", agentNumber)
    .maybeSingle();
  if (!numberRow?.attached_campaign_id) return NOT_BLOCKED;

  const { data: campaign } = await supabase
    .from("campaigns")
    .select("id, owner_id")
    .eq("id", numberRow.attached_campaign_id)
    .maybeSingle();
  if (!campaign?.owner_id) return NOT_BLOCKED;

  // limit(1), not maybeSingle(): maybeSingle() errors on two rows, and an
  // unreadable list must read as "not blocked", never as "blocked".
  const { data: hits, error } = await supabase
    .from("dnc_entries")
    .select("phone")
    .eq("phone", callerNumber)
    .eq("owner_id", campaign.owner_id)
    .limit(1);
  if (error || !hits || hits.length === 0) return NOT_BLOCKED;

  return { blocked: true, campaignId: campaign.id, ownerId: campaign.owner_id };
}
