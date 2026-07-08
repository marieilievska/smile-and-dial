import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { loadActiveFlagDefs } from "./rubric";
import { analyzeCall } from "./analyze";
import { PASS1_MODEL, PASS2_MODEL } from "./openai";

type Admin = ReturnType<typeof createClient<Database>>;

function admin(): Admin {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

export type ReviewTickSummary = {
  claimed: number;
  analyzed: number;
  errors: number;
};

/** Turn a stored transcript_json into a plain "Speaker: text" string. */
function transcriptToText(raw: unknown): string {
  const turns = Array.isArray(raw)
    ? raw
    : raw &&
        typeof raw === "object" &&
        Array.isArray((raw as { transcript?: unknown }).transcript)
      ? (raw as { transcript: unknown[] }).transcript
      : [];
  return (turns as Record<string, unknown>[])
    .map((t) => {
      const role = t.role === "user" ? "Lead" : "Agent";
      const msg =
        typeof t.message === "string"
          ? t.message
          : typeof t.text === "string"
            ? t.text
            : "";
      return msg ? `${role}: ${msg}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

/** One review tick: claim pending reviews, analyze, store flags. Idempotent. */
export async function runReviewTick(
  opts: { limit?: number } = {},
): Promise<ReviewTickSummary> {
  const db = admin();
  const summary: ReviewTickSummary = { claimed: 0, analyzed: 0, errors: 0 };

  const { data: pending } = await db
    .from("call_reviews")
    .select("call_id")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(opts.limit ?? 25);
  if (!pending || pending.length === 0) return summary;

  const defs = await loadActiveFlagDefs(db);

  for (const row of pending) {
    const { data: claimed } = await db
      .from("call_reviews")
      .update({ status: "analyzing" })
      .eq("call_id", row.call_id)
      .eq("status", "pending")
      .select("call_id");
    if (!claimed || claimed.length === 0) continue;
    summary.claimed++;

    try {
      const { data: call } = await db
        .from("calls")
        .select("transcript_json, extracted_data")
        .eq("id", row.call_id)
        .maybeSingle();
      const transcript = transcriptToText(call?.transcript_json);
      if (!transcript.trim()) {
        await db
          .from("call_reviews")
          .update({ status: "done", analyzed_at: new Date().toISOString() })
          .eq("call_id", row.call_id);
        continue;
      }
      const { flags, cost } = await analyzeCall({
        transcript,
        extracted: JSON.stringify(call?.extracted_data ?? {}),
        defs,
      });
      for (const f of flags) {
        await db
          .from("call_review_flags")
          .upsert(
            {
              call_id: row.call_id,
              flag_key: f.flag_key,
              evidence_quote: f.evidence_quote,
              confidence: f.confidence,
              status: f.status,
            },
            { onConflict: "call_id,flag_key" },
          );
      }
      await db
        .from("call_reviews")
        .update({
          status: "done",
          needs_review: flags.some((f) => f.status === "needs_review"),
          pass1_model: PASS1_MODEL,
          pass2_model: PASS2_MODEL,
          cost,
          analyzed_at: new Date().toISOString(),
        })
        .eq("call_id", row.call_id);
      summary.analyzed++;
    } catch (e) {
      summary.errors++;
      await db
        .from("call_reviews")
        .update({
          status: "error",
          error: e instanceof Error ? e.message : "unknown",
        })
        .eq("call_id", row.call_id);
    }
  }
  return summary;
}
