import type { SupabaseClient } from "@supabase/supabase-js";

import {
  extractObjection,
  transcriptToText,
} from "@/lib/openai/objection-extractor";
import type { Database } from "@/lib/supabase/database.types";

type Admin = SupabaseClient<Database>;

const CONVERSATION_NON_WON = [
  "not_interested",
  "gatekeeper",
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

  let withObjection = 0;
  let cost = 0;
  const nowIso = new Date().toISOString();
  for (const row of data ?? []) {
    const text = transcriptToText(
      (row as { transcript_json: unknown }).transcript_json,
    );
    const { objection, cost: c } = await extractObjection(text);
    cost += c;
    if (objection) withObjection += 1;

    const prev = ((row as { cost_breakdown: Record<string, number> | null })
      .cost_breakdown ?? {}) as Record<string, number>;
    const cost_breakdown = { ...prev, openai: (prev.openai ?? 0) + c };

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
  return { analyzed: (data ?? []).length, withObjection, cost };
}
