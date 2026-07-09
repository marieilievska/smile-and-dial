import "server-only";
import type { createClient as createServerClient } from "@/lib/supabase/server";
import type { ReviewFlagDef } from "./types";

type ServerClient = Awaited<ReturnType<typeof createServerClient>>;

/** A raw per-flag count row from the `review_bucket_counts` view. */
export type BucketCountRow = {
  flag_key: string | null;
  confirmed_count: number | null;
  needs_review_count: number | null;
  unreviewed_count: number | null;
};

/** A bucket shaped for the UI: one flag, its def metadata, and its counts. */
export type ReviewBucket = {
  key: string;
  label: string;
  lens: ReviewFlagDef["lens"];
  severity: number;
  /** confirmed + needs_review — every real flag on a call in this bucket. */
  total: number;
  /** How many of those are the AI-vs-AI disagreements needing a human. */
  needsReview: number;
  /** Calls in this bucket not yet marked reviewed. */
  unreviewed: number;
};

/** Top-of-tab roll-up. */
export type ReviewSummary = {
  flaggedCalls: number;
  unreviewedCalls: number;
  needsEyesCalls: number;
};

type DefLite = Pick<ReviewFlagDef, "key" | "label" | "lens" | "severity">;

/**
 * Shape raw view rows into ordered UI buckets. Pure (no I/O) so it's unit
 * tested. Rules: keep only flags that still have an active def (retired flags
 * drop out), drop empty buckets, order by severity (1 = highest first) then by
 * total desc so the biggest, most severe buckets float to the top.
 */
export function orderBuckets(
  rows: BucketCountRow[],
  defs: DefLite[],
): ReviewBucket[] {
  const defByKey = new Map(defs.map((d) => [d.key, d]));
  const out: ReviewBucket[] = [];
  for (const r of rows) {
    if (!r.flag_key) continue;
    const def = defByKey.get(r.flag_key);
    if (!def) continue;
    const total = (r.confirmed_count ?? 0) + (r.needs_review_count ?? 0);
    if (total <= 0) continue;
    out.push({
      key: def.key,
      label: def.label,
      lens: def.lens,
      severity: def.severity,
      total,
      needsReview: r.needs_review_count ?? 0,
      unreviewed: r.unreviewed_count ?? 0,
    });
  }
  out.sort((a, b) => a.severity - b.severity || b.total - a.total);
  return out;
}

/**
 * Load the Call Review tab's data: the roll-up + the ordered buckets. Reads the
 * two aggregation views + the active rubric through the caller's admin-gated
 * RLS client (the views are security_invoker, so a non-admin sees nothing).
 */
export async function fetchReviewBuckets(
  client: ServerClient,
): Promise<{ summary: ReviewSummary; buckets: ReviewBucket[] }> {
  const [{ data: counts }, { data: summaryRow }, { data: defs }] =
    await Promise.all([
      client
        .from("review_bucket_counts")
        .select(
          "flag_key, confirmed_count, needs_review_count, unreviewed_count",
        ),
      client
        .from("review_summary")
        .select("flagged_calls, unreviewed_calls, needs_eyes_calls")
        .maybeSingle(),
      client
        .from("review_flag_defs")
        .select("key, label, lens, severity")
        .eq("active", true),
    ]);

  const buckets = orderBuckets(
    (counts ?? []) as BucketCountRow[],
    (defs ?? []) as DefLite[],
  );
  const summary: ReviewSummary = {
    flaggedCalls: summaryRow?.flagged_calls ?? 0,
    unreviewedCalls: summaryRow?.unreviewed_calls ?? 0,
    needsEyesCalls: summaryRow?.needs_eyes_calls ?? 0,
  };
  return { summary, buckets };
}
