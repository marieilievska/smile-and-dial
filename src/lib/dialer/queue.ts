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
 *
 * Kept in sync with the LATEST pre_call_check definition
 * (supabase/migrations/20260724120000_daily_caps_eastern_day.sql). The three
 * pre-pool number reasons this used to list — campaign_has_no_twilio_number,
 * twilio_number_missing, twilio_number_reassigned — stopped being reachable
 * when the number pool replaced the single-number model
 * (20260718150100_pre_call_check_pool.sql) and are replaced by the single
 * campaign_has_no_numbers. If you change the SQL function's return values,
 * change this union too.
 */
export type PreCallReason =
  | "lead_missing_or_deleted"
  | "lead_has_no_phone"
  | "lead_on_dnc"
  | "lead_is_mobile"
  | "call_in_flight"
  | "campaign_not_active"
  | "campaign_has_no_numbers"
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
 * (src/lib/dialer/tick.ts) builds its own `dial_queue` query instead of using
 * this function, and the two have drifted further than the column list: this
 * is a single GLOBAL top-N read, while the tick now reads a FAIR SHARE per
 * active campaign and round-robin merges them (`readFairQueue`). A global
 * top-N read is exactly the bug that let one campaign monopolize every
 * candidate slot when two campaigns share a list — so do NOT copy this shape
 * into anything that dials. Treat readFairQueue as the live one; if you're
 * changing queue selection/ordering semantics, change it there, and update
 * this copy too (or delete it) rather than editing only one.
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
    // LOCAL MATCH: mirrors tick.ts so the preview shows the order the dialer
    // will actually use. PostgREST replaces the view's ORDER BY with these, so
    // omitting them here would silently show a different order than we dial.
    .order("dest_rank", { ascending: true })
    .order("local_match_rank", { ascending: true })
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
