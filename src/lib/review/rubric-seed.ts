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
 * The built-in rubric for the Call Reviewer.
 *
 * Two kinds of thing get graded, and only one of them lives here:
 *  - What the agent had to DO is derived per agent from its own system prompt
 *    (see playbook.ts) and surfaces under the single `playbook_missed` key, with
 *    the specific step recorded alongside it. Nothing agent-specific belongs in
 *    this file — hard-coding one agent's beats was the old design's mistake.
 *  - HOW the agent talked, plus hard compliance, is the same for every agent
 *    and is what this list covers.
 *
 * This is the runtime mirror of the SQL seed in
 * `20260719130000_review_rubric_rebuild.sql`. It exists in code so the rubric
 * can SELF-HEAL: a prod data reset has repeatedly wiped `review_flag_defs`, and
 * because the seed only lived in already-applied migrations, nothing restored it
 * — the Call Review tab silently went empty (no active flags → Pass 1 finds
 * nothing; missing `no_conversation` def → non-human calls' catch-all flag
 * FK-fails silently).
 *
 * KEEP IN SYNC with that migration — `tests/review-rubric-seed.unit.test.ts`
 * fails if the keys drift apart. `active`/`is_candidate` are intentionally
 * omitted so the table defaults apply (active=true, is_candidate=false).
 */
export const STANDARD_RUBRIC: StandardFlagSeed[] = [
  {
    key: "dnc_not_honored",
    label: "DNC not honored",
    lens: "compliance",
    severity: 1,
    guidance:
      "The person asked not to be called / to stop, and the agent kept pitching instead of confirming removal and ending the call.",
    sort_order: 1,
  },
  {
    key: "misleading_claim",
    label: "Misleading claim",
    lens: "compliance",
    severity: 1,
    guidance:
      "The agent stated something untrue or misleading about the offer, price, or company.",
    sort_order: 2,
  },
  {
    key: "overpromised",
    label: "Overpromised",
    lens: "compliance",
    severity: 1,
    guidance: "The agent promised something we may not be able to deliver.",
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
    key: "playbook_missed",
    label: "Skipped a required step",
    lens: "quality",
    severity: 2,
    guidance:
      "The agent skipped a step its own playbook required, in a situation where that step actually applied.",
    sort_order: 5,
  },
  {
    key: "reasked_known_info",
    label: "Asked something they'd already said",
    lens: "quality",
    severity: 2,
    guidance:
      "The agent asked for something this same person already told them earlier on this call.",
    sort_order: 10,
  },
  {
    key: "repeated_itself",
    label: "Repeated itself",
    lens: "quality",
    severity: 2,
    guidance:
      "The agent said substantially the same thing twice, or got stuck in a loop.",
    sort_order: 11,
  },
  {
    key: "canned_delivery",
    label: "Sounded scripted",
    lens: "quality",
    severity: 2,
    guidance:
      "The agent sounded recited rather than conversational — marketing voice, slick value-prop phrasing, or its playbook's sample lines delivered near word-for-word.",
    sort_order: 12,
  },
  {
    key: "pushy_after_no",
    label: "Kept pushing after a no",
    lens: "quality",
    severity: 2,
    guidance:
      "The person declined or tried to end the call and the agent kept pitching.",
    sort_order: 13,
  },
  {
    key: "monologued",
    label: "Monologued",
    lens: "quality",
    severity: 3,
    guidance:
      "The agent stacked several points into one turn instead of asking one thing and handing the turn back.",
    sort_order: 14,
  },
  {
    key: "talked_over",
    label: "Talked over them",
    lens: "quality",
    severity: 3,
    guidance:
      "The person started speaking and the agent kept going instead of stopping and following them.",
    sort_order: 15,
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
];

/**
 * Self-heal the rubric: if the built-in flags are missing (a prod data reset
 * wiped `review_flag_defs`), re-insert them so Call Review can never silently go
 * empty again. A cheap no-op when the rubric is already present.
 *
 * Uses `no_conversation` as the sentinel (the always-needed catch-all). The
 * upsert is `ignoreDuplicates` on the unique `key`, so it only fills gaps and
 * NEVER flips `active`/`is_candidate` on an existing row — flags the operator
 * has retired stay retired.
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
