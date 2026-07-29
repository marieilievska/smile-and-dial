import type { PreCallReason } from "./queue";

/**
 * Is a `pre_call_check` refusal about the CAMPAIGN rather than the lead?
 *
 * The distinction drives two things in the dialer tick:
 *
 *  1. **Whether to bump the lead's `next_call_at`.** Bumping is how the tick
 *     stops one stuck lead jamming the head of the queue — which only makes
 *     sense when the lead itself is the problem. When a campaign is capped out,
 *     the lead did nothing wrong, and stamping it writes a schedule it never
 *     earned. Measured on 2026-07-29: 9,183 never-called leads carried a
 *     `next_call_at` written entirely by these blocks, and 93.8% of all stamps
 *     landed in bulk bursts of ~50 (one full queue read) in a single minute.
 *     That churn also destroyed `next_call_at` as a "never scheduled" signal —
 *     see the `dial_queue` first-call gate migration.
 *
 *  2. **Whether to keep walking the candidate list.** A campaign-level refusal
 *     will repeat identically for every remaining candidate of that campaign,
 *     so continuing costs one `pre_call_check` round trip per candidate and
 *     dials nothing. Skipping the rest turns a capped tick from ~50 checks and
 *     ~50 writes into one check and no writes.
 *
 * `pacing_wait` is deliberately EXCLUDED even though it is campaign-scoped: the
 * tick paces with in-loop sleeps and `pre_call_check` is only the cross-tick
 * backstop, so short-circuiting the whole tick on it would cut throughput to a
 * single call per tick per campaign. It already skips the bump on its own.
 */
const CAMPAIGN_LEVEL_BLOCKS: ReadonlySet<string> = new Set<PreCallReason>([
  "campaign_not_active",
  "campaign_has_no_numbers",
  "hourly_cap_hit",
  "daily_cap_hit",
  // Owner-scoped rather than campaign-scoped, but every campaign of that owner
  // is equally stuck, and one owner per campaign is the norm here.
  "concurrency_cap_hit",
  "daily_spend_cap_hit",
  "monthly_spend_cap_hit",
]);

export function isCampaignLevelBlock(reason: string): boolean {
  return CAMPAIGN_LEVEL_BLOCKS.has(reason);
}
