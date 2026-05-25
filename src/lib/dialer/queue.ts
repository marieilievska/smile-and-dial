import "server-only";

import { createClient } from "@/lib/supabase/server";

/** One row out of the dial_queue view. */
export type DialQueueEntry = {
  lead_id: string;
  owner_id: string;
  business_phone: string;
  campaign_id: string;
  agent_id: string | null;
  twilio_number_id: string | null;
};

/**
 * Reasons pre_call_check can return. Null means safe to dial. The cron logs
 * these so we can see at a glance why a candidate was dropped.
 */
export type PreCallReason =
  | "lead_missing_or_deleted"
  | "lead_has_no_phone"
  | "lead_on_dnc"
  | "campaign_not_active"
  | "campaign_has_no_twilio_number"
  | "twilio_number_missing"
  | "twilio_number_reassigned"
  | "outside_calling_hours"
  | "hourly_cap_hit"
  | "daily_cap_hit"
  | "concurrency_cap_hit"
  | "daily_spend_cap_hit"
  | "monthly_spend_cap_hit";

/**
 * Fetch up to `limit` candidates from the dial queue, oldest-due first.
 * This is the "lightweight" filter pass — cap, spend, and concurrency
 * checks happen in `preCallCheck` because they require aggregating from
 * the calls table, which is more expensive.
 */
export async function readDialQueue(limit = 50): Promise<DialQueueEntry[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("dial_queue")
    .select(
      "lead_id, owner_id, business_phone, campaign_id, agent_id, twilio_number_id",
    )
    .order("next_call_at", { ascending: true, nullsFirst: true })
    .limit(limit);
  // `lead_id`, `owner_id`, `business_phone`, `campaign_id` are non-null in
  // the view by construction; the type generator can't see that.
  return (data ?? []).filter(
    (row): row is DialQueueEntry =>
      typeof row.lead_id === "string" &&
      typeof row.owner_id === "string" &&
      typeof row.business_phone === "string" &&
      typeof row.campaign_id === "string",
  );
}

/**
 * Final verification before firing a call. Runs as security definer in PG
 * so the result is consistent regardless of the calling user's RLS view.
 * Returns null when safe to dial, otherwise the rejection reason.
 */
export async function preCallCheck(
  leadId: string,
  campaignId: string,
): Promise<PreCallReason | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("pre_call_check", {
    in_lead_id: leadId,
    in_campaign_id: campaignId,
  });
  if (error) {
    // Treat an RPC failure as a soft block: don't dial, and surface the
    // error string for logging. Casting to PreCallReason here is a lie,
    // but it keeps the call site type-safe for the common path.
    return ("pre_call_check_error: " + error.message) as PreCallReason;
  }
  return (data ?? null) as PreCallReason | null;
}
