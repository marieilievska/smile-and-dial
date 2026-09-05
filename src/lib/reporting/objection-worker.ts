import type { SupabaseClient } from "@supabase/supabase-js";

import { numField, withRecomputedTotal } from "@/lib/costs/breakdown";
import {
  extractObjection,
  transcriptToText,
} from "@/lib/openai/objection-extractor";
import type { Database } from "@/lib/supabase/database.types";

type Admin = SupabaseClient<Database>;

const CONVERSATION_NON_WON = [
  "not_interested",
  "gatekeeper",
  "gatekeeper_not_interested",
  "callback",
  "transferred_to_human",
  "language_barrier",
];

/** Analyze one batch of not-yet-analyzed conversation calls: classify the
 *  lead's objection from the transcript and store it. Sets objection_analyzed_at
 *  on every call it touches (even when no objection is found) so each call is
 *  analyzed at most once — draining the backfill over successive runs. */
export async function runObjectionExtraction(
  admin: Admin,
  opts: { limit?: number } = {},
): Promise<{ analyzed: number; withObjection: number; cost: number }> {
  const limit = opts.limit ?? 25;
  const { data, error } = await admin
    .from("calls")
    .select("id, transcript_json, cost_breakdown")
    .is("objection_analyzed_at", null)
    .eq("goal_met", false)
    .in("outcome", CONVERSATION_NON_WON)
    .order("started_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);

  let analyzed = 0;
  let withObjection = 0;
  let cost = 0;
  const nowIso = new Date().toISOString();
  for (const row of data ?? []) {
    const text = transcriptToText(
      (row as { transcript_json: unknown }).transcript_json,
    );
    const { objection, cost: c, ok } = await extractObjection(text);
    // Analysis failed (no key / network / non-2xx). Leave objection_analyzed_at
    // NULL so this call is retried on a later run, instead of permanently
    // blanking it during an OpenAI outage. Don't write partial data or cost.
    if (!ok) continue;
    analyzed += 1;
    cost += c;
    if (objection) withObjection += 1;

    // Bump `openai` AND recompute the stored total — bumping the component
    // alone left `total` stale on ~1,200 calls, and the stored total is what
    // the Calls list, the call modal and pre_call_check read.
    const prev = ((row as { cost_breakdown: unknown }).cost_breakdown ??
      {}) as Record<string, unknown>;
    const cost_breakdown = withRecomputedTotal({
      ...prev,
      openai: Number((numField(prev, "openai") + c).toFixed(4)),
    });

    await admin
      .from("calls")
      .update({
        objection_category: objection?.category ?? null,
        objection_specific: objection?.specific || null,
        objection_quote: objection?.quote || null,
        objection_analyzed_at: nowIso,
        cost_breakdown,
      })
      .eq("id", (row as { id: string }).id);
  }
  return { analyzed, withObjection, cost };
}
