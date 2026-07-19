import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { ReviewFlagDef } from "./types";

type Admin = ReturnType<typeof createClient<Database>>;

/** All ACTIVE, non-candidate rubric flags, ordered for a stable prompt. */
export async function loadActiveFlagDefs(
  admin: Admin,
): Promise<ReviewFlagDef[]> {
  const { data } = await admin
    .from("review_flag_defs")
    .select("key, label, lens, severity, guidance")
    .eq("active", true)
    .eq("is_candidate", false)
    .order("sort_order", { ascending: true });
  return (data ?? []) as ReviewFlagDef[];
}

/** Flags the AI must never be offered, because they're applied deterministically
 *  elsewhere. `no_conversation` is stamped at enqueue time on calls that never
 *  reached a human; leaving it in the AI's list meant a short-but-real
 *  conversation could be labelled "no real conversation happened". */
const NOT_AI_JUDGED = new Set(["no_conversation"]);

/** The defs the analyzer may propose. */
export function defsForAnalysis(defs: ReviewFlagDef[]): ReviewFlagDef[] {
  return defs.filter((d) => !NOT_AI_JUDGED.has(d.key));
}
