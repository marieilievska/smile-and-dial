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
  /** True when this row surfaced because of a live double-call marker. */
  is_redial_due: boolean;
  /** The number call 1 used, to be reused for the redial. */
  redial_number_id: string | null;
};

/**
 * Reasons pre_call_check can return. Null means safe to dial. The cron logs
 * these so we can see at a glance why a candidate was dropped.
 */
export type PreCallReason =
  | "lead_missing_or_deleted"
  | "lead_has_no_phone"
  | "lead_on_dnc"
  | "lead_is_mobile"
  | "call_in_flight"
  | "campaign_not_active"
  | "campaign_has_no_twilio_number"
  | "twilio_number_missing"
  | "twilio_number_reassigned"
  | "outside_calling_hours"
  | "pacing_wait"
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
 *
 * NOT CURRENTLY CALLED anywhere in the repo. `runDialerTick`
 * (src/lib/dialer/tick.ts) builds its own inline `dial_queue` query instead
 * of using this function, and the two have already drifted (this one still
 * selects `twilio_number_id`; the tick's inline query doesn't). Treat
 * tick.ts's inline query as the live one — if you're changing queue
 * selection/ordering semantics, change it there, and update this copy too
 * (or delete it) rather than editing only one.
 */
export async function readDialQueue(limit = 50): Promise<DialQueueEntry[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("dial_queue")
    .select(
      "lead_id, owner_id, business_phone, campaign_id, agent_id, twilio_number_id, is_redial_due, redial_number_id",
    )
    .order("dial_priority", { ascending: true })
    // The band matters more than the sort key. queue_order ALONE puts a redial
    // LAST: its timestamp is ~30s old while a backlog lead's next_call_at is
    // days old, and ascending means oldest first. With ~33k due leads and a
    // 50-row limit it would never surface inside its 10-minute window.
    .order("is_redial_due", { ascending: false })
    .order("queue_order", { ascending: true, nullsFirst: true })
    .limit(limit);
  // `lead_id`, `owner_id`, `business_phone`, `campaign_id` are non-null in
  // the view by construction; the type generator can't see that.
  return (data ?? [])
    .filter(
      (row) =>
        typeof row.lead_id === "string" &&
        typeof row.owner_id === "string" &&
        typeof row.business_phone === "string" &&
        typeof row.campaign_id === "string",
    )
    .map((row) => ({
      ...row,
      is_redial_due: row.is_redial_due === true,
    })) as DialQueueEntry[];
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
