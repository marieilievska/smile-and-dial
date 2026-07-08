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

/** Render the rubric as a numbered list the analyzer prompt embeds. */
export function buildRubricText(defs: ReviewFlagDef[]): string {
  return defs
    .map((d) => `- ${d.key} (${d.lens}): ${d.label}. ${d.guidance}`)
    .join("\n");
}
