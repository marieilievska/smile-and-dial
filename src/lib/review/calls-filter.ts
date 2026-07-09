import "server-only";
import type { createClient } from "@/lib/supabase/server";

type ServerClient = Awaited<ReturnType<typeof createClient>>;

/** Sentinel /calls?review_flag value for the cross-cutting "needs your eyes"
 *  bucket (all needs_review flags, any flag_key). No real flag_key uses a
 *  hyphen, so this can't collide. Mirrored in call-review-table.tsx. */
export const NEEDS_REVIEW_BUCKET = "needs-review";

/** One call's flag(s) relevant to the active review_flag view. */
export type CallEvidence = {
  flagKey: string;
  evidenceQuote: string | null;
  status: "confirmed" | "needs_review" | "rejected";
};

/**
 * Resolve a review_flag param value to the set of call_ids it selects, or null
 * when the param is absent/blank (caller then adds no review filter). For a real
 * flag key: calls with that flag in confirmed OR needs_review. For the
 * NEEDS_REVIEW_BUCKET sentinel: calls with ANY needs_review flag. Rejected flags
 * never select a call. Paginates so it isn't capped at 1000 ids.
 */
export async function resolveReviewFlagCallIds(
  supabase: ServerClient,
  reviewFlag: string,
): Promise<string[] | null> {
  const key = reviewFlag.trim();
  if (!key) return null;

  const ids: string[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let q = supabase
      .from("call_review_flags")
      .select("call_id")
      // Stable order is REQUIRED across range requests: without it Postgres may
      // return rows in a different order on each page (especially while the
      // operator is writing confirm/reject changes), which would silently SKIP
      // call_ids past page 1 — the Set dedup can absorb duplicates but can't
      // recover a skipped id. Order by the PK so paging is deterministic.
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (key === NEEDS_REVIEW_BUCKET) {
      q = q.eq("status", "needs_review");
    } else {
      q = q.eq("flag_key", key).in("status", ["confirmed", "needs_review"]);
    }
    const { data } = await q;
    const rows = data ?? [];
    for (const r of rows) if (r.call_id) ids.push(r.call_id);
    if (rows.length < PAGE) break;
  }
  // De-dupe (a call can appear once per flag; needs-review sentinel is 1/call).
  return [...new Set(ids)];
}

/**
 * For the calls visible on the page, load the flag evidence to surface in the
 * evidence column. Scoped to the same review_flag the list is filtered by, so
 * the quote shown matches the bucket the operator came from.
 */
export async function fetchCallEvidence(
  supabase: ServerClient,
  reviewFlag: string,
  callIds: string[],
): Promise<Map<string, CallEvidence[]>> {
  const key = reviewFlag.trim();
  const map = new Map<string, CallEvidence[]>();
  if (!key || callIds.length === 0) return map;

  let q = supabase
    .from("call_review_flags")
    .select("call_id, flag_key, evidence_quote, status")
    .in("call_id", callIds);
  if (key === NEEDS_REVIEW_BUCKET) {
    q = q.eq("status", "needs_review");
  } else {
    q = q.eq("flag_key", key).in("status", ["confirmed", "needs_review"]);
  }
  const { data } = await q;
  for (const r of data ?? []) {
    if (!r.call_id) continue;
    const arr = map.get(r.call_id) ?? [];
    arr.push({
      flagKey: r.flag_key,
      evidenceQuote: r.evidence_quote,
      status: r.status as CallEvidence["status"],
    });
    map.set(r.call_id, arr);
  }
  return map;
}
