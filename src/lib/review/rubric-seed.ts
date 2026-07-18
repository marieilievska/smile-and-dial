import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

type Admin = ReturnType<typeof createClient<Database>>;

export type RubricLens =
  | "bug"
  | "compliance"
  | "quality"
  | "opportunity"
  | "voc";

export type StandardFlagSeed = {
  key: string;
  label: string;
  lens: RubricLens;
  severity: number;
  guidance: string;
  sort_order: number;
};

/**
 * The built-in starter rubric for the Call Reviewer.
 *
 * This is the runtime mirror of the SQL seed in the two migrations
 * `20260714120000_reseed_review_flag_defs.sql` (the 29 standard flags incl.
 * `no_conversation`) and `20260715140000_call_review_agent_playbook.sql`
 * (`off_script`). It exists in code so the rubric can SELF-HEAL: a prod data
 * reset has repeatedly wiped `review_flag_defs`, and because the seed only lived
 * in already-applied migrations, nothing restored it — the Call Review tab
 * silently went empty (no active flags → Pass 1 finds nothing; missing
 * `no_conversation` def → non-human calls' catch-all flag FK-fails silently).
 *
 * KEEP IN SYNC with those two migrations — `tests/review-rubric-seed.unit.test.ts`
 * fails if the keys drift apart. `active`/`is_candidate` are intentionally
 * omitted so the table defaults apply (active=true, is_candidate=false) → these
 * insert as standard, active flags, exactly like the migrations.
 */
export const STANDARD_RUBRIC: StandardFlagSeed[] = [
  {
    key: "booking_failed_then_recovered",
    label: "Booking failed then recovered",
    lens: "bug",
    severity: 1,
    guidance:
      "The booking tool errored or the agent said a time was unavailable, then the SAME appointment/slot was booked anyway — a confusing failure the customer heard.",
    sort_order: 1,
  },
  {
    key: "tool_error",
    label: "Tool error mid-call",
    lens: "bug",
    severity: 1,
    guidance:
      "A server tool (booking, email, callback, transfer) failed or returned an error during the call.",
    sort_order: 2,
  },
  {
    key: "wrong_data_used",
    label: "Wrong lead data used",
    lens: "bug",
    severity: 1,
    guidance:
      "The agent used a stale or wrong name/company/detail for this business (e.g. called them by a different company name).",
    sort_order: 3,
  },
  {
    key: "dead_air",
    label: "Dead air / long silence",
    lens: "bug",
    severity: 2,
    guidance:
      "Noticeable silence or latency where the agent should have responded.",
    sort_order: 4,
  },
  {
    key: "dropped_midconversation",
    label: "Dropped mid-conversation",
    lens: "bug",
    severity: 2,
    guidance: "The call ended abruptly in the middle of a real conversation.",
    sort_order: 5,
  },
  {
    key: "agent_looped",
    label: "Agent looped / stuck",
    lens: "bug",
    severity: 2,
    guidance: "The agent repeated itself or got stuck in a loop.",
    sort_order: 6,
  },
  {
    key: "transfer_failed",
    label: "Transfer failed",
    lens: "bug",
    severity: 2,
    guidance: "A transfer to a human was attempted but did not connect.",
    sort_order: 7,
  },
  {
    key: "dnc_not_honored",
    label: "DNC not honored",
    lens: "compliance",
    severity: 1,
    guidance:
      "The person asked not to be called / to stop, and the agent kept pitching instead of ending.",
    sort_order: 10,
  },
  {
    key: "misleading_claim",
    label: "Misleading claim",
    lens: "compliance",
    severity: 1,
    guidance:
      "The agent stated something untrue or misleading about the offer, price, or company.",
    sort_order: 11,
  },
  {
    key: "overpromised",
    label: "Overpromised",
    lens: "compliance",
    severity: 1,
    guidance: "The agent promised something we may not be able to deliver.",
    sort_order: 12,
  },
  {
    key: "wrong_info_given",
    label: "Wrong info given",
    lens: "quality",
    severity: 2,
    guidance:
      "The agent gave factually incorrect information about the product/offer (not necessarily misleading on purpose).",
    sort_order: 20,
  },
  {
    key: "fumbled_objection",
    label: "Fumbled an objection",
    lens: "quality",
    severity: 2,
    guidance:
      "The customer raised a question/objection and the agent ignored it, argued, or answered poorly.",
    sort_order: 21,
  },
  {
    key: "rambled_unclear",
    label: "Rambled / unclear",
    lens: "quality",
    severity: 3,
    guidance: "The agent was long-winded, confusing, or off-message.",
    sort_order: 22,
  },
  {
    key: "pushy_or_rude",
    label: "Pushy or rude",
    lens: "quality",
    severity: 2,
    guidance: "The agent was aggressive, interrupted, or disrespectful.",
    sort_order: 23,
  },
  {
    key: "off_goal",
    label: "Never advanced the goal",
    lens: "quality",
    severity: 3,
    guidance:
      "The agent never moved toward the campaign goal (e.g. never offered to book / never asked the research questions).",
    sort_order: 24,
  },
  {
    key: "didnt_confirm_details",
    label: "Did not confirm details",
    lens: "quality",
    severity: 3,
    guidance:
      "The agent captured an email/time/booking but never read it back to confirm.",
    sort_order: 25,
  },
  {
    key: "awkward_delivery",
    label: "Awkward delivery",
    lens: "quality",
    severity: 3,
    guidance:
      "Robotic delivery or mispronounced the business/brand/contact name.",
    sort_order: 26,
  },
  {
    key: "hot_lead_not_booked",
    label: "Hot lead not booked",
    lens: "opportunity",
    severity: 2,
    guidance:
      "The customer showed clear interest but no booking or concrete next step was secured.",
    sort_order: 30,
  },
  {
    key: "decision_maker_no_ask",
    label: "Reached DM, no ask",
    lens: "opportunity",
    severity: 2,
    guidance:
      "The agent reached the owner/decision maker but did not push for the goal.",
    sort_order: 31,
  },
  {
    key: "callback_promised_not_scheduled",
    label: "Callback promised, not scheduled",
    lens: "opportunity",
    severity: 2,
    guidance:
      "The customer agreed to talk later but no callback time was captured.",
    sort_order: 32,
  },
  {
    key: "goal_met_needs_followup",
    label: "Won, needs follow-up",
    lens: "opportunity",
    severity: 3,
    guidance:
      "The goal was met but the call suggests a human follow-up would help.",
    sort_order: 33,
  },
  {
    key: "price_objection",
    label: "Price objection",
    lens: "voc",
    severity: 4,
    guidance: "The customer pushed back on cost/price.",
    sort_order: 40,
  },
  {
    key: "not_interested_reason",
    label: "Not interested (reason)",
    lens: "voc",
    severity: 4,
    guidance: "The customer declined — capture WHY in the evidence quote.",
    sort_order: 41,
  },
  {
    key: "competitor_mentioned",
    label: "Competitor mentioned",
    lens: "voc",
    severity: 4,
    guidance: "The customer named a competitor or their current provider.",
    sort_order: 42,
  },
  {
    key: "software_mentioned",
    label: "Software mentioned",
    lens: "voc",
    severity: 4,
    guidance: "The customer named their CRM/booking/business software.",
    sort_order: 43,
  },
  {
    key: "feature_or_need_request",
    label: "Feature/need request",
    lens: "voc",
    severity: 4,
    guidance: "The customer asked for something specific or expressed a need.",
    sort_order: 44,
  },
  {
    key: "strong_interest",
    label: "Strong interest",
    lens: "voc",
    severity: 4,
    guidance: "The customer was clearly enthusiastic / strongly interested.",
    sort_order: 45,
  },
  {
    key: "confused_by_offer",
    label: "Confused by the offer",
    lens: "voc",
    severity: 4,
    guidance: "The customer did not understand the offer or pitch.",
    sort_order: 46,
  },
  {
    key: "no_conversation",
    label: "No conversation",
    lens: "voc",
    severity: 4,
    guidance:
      "Voicemail, no-answer, or instant hang-up — no real conversation happened.",
    sort_order: 50,
  },
  {
    key: "off_script",
    label: "Off-script — didn't follow instructions",
    lens: "quality",
    severity: 2,
    guidance:
      "The agent did not follow its own instructions/playbook for this call. Only evaluate when the agent's instructions are provided; quote the transcript moment where it deviated.",
    sort_order: 100,
  },
];

/**
 * Self-heal the rubric: if the built-in starter flags are missing (a prod data
 * reset wiped `review_flag_defs`), re-insert them so Call Review can never
 * silently go empty again. A cheap no-op when the rubric is already present.
 *
 * Uses `no_conversation` as the sentinel (the always-needed catch-all). The
 * upsert is `ignoreDuplicates` on the unique `key`, so it only fills gaps and
 * NEVER flips `active`/`is_candidate` on an existing row — approved standard
 * flags and discovery candidates are left exactly as they are.
 */
export async function ensureStandardRubric(db: Admin): Promise<void> {
  const { data, error } = await db
    .from("review_flag_defs")
    .select("key")
    .eq("key", "no_conversation")
    .limit(1);
  // On a read error, do nothing rather than risk a spurious write.
  if (error) return;
  if (data && data.length > 0) return; // rubric present → nothing to heal
  await db
    .from("review_flag_defs")
    .upsert(STANDARD_RUBRIC, { onConflict: "key", ignoreDuplicates: true });
}
