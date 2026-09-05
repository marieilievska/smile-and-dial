/**
 * Reasons pre_call_check can return. Null means safe to dial. The dialer tick
 * logs these so we can see at a glance why a candidate was dropped.
 *
 * Kept in sync with the LATEST pre_call_check definition
 * (supabase/migrations/20260724120000_daily_caps_eastern_day.sql). The three
 * pre-pool number reasons this used to list — campaign_has_no_twilio_number,
 * twilio_number_missing, twilio_number_reassigned — stopped being reachable
 * when the number pool replaced the single-number model
 * (20260718150100_pre_call_check_pool.sql) and are replaced by the single
 * campaign_has_no_numbers. If you change the SQL function's return values,
 * change this union too.
 *
 * This module is types-only. The `readDialQueue` / `preCallCheck` helpers that
 * used to live here had no callers — the tick reads its own fair-share queue
 * (`readFairQueue` in tick.ts) and has its own dial gate — and were removed.
 * The type stays at this path because tick.ts and block-scope.ts import it
 * from here.
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
