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

/** A pending candidate flag for the "Suggested new flags" panel. */
export type CandidateFlag = {
  key: string;
  label: string;
  lens: ReviewFlagDef["lens"];
  severity: number;
  guidance: string;
  rationale: string | null;
  exampleCallIds: string[];
  proposedAt: string | null;
};

/** Pending (not-yet-approved, not-dismissed) discovery candidates, newest
 *  first. Read through the caller's admin-gated RLS client. */
export async function fetchCandidateFlags(
  client: ServerClient,
): Promise<CandidateFlag[]> {
  const { data } = await client
    .from("review_flag_defs")
    .select(
      "key, label, lens, severity, guidance, rationale, example_call_ids, proposed_at",
    )
    .eq("is_candidate", true)
    .is("dismissed_at", null)
    .order("proposed_at", { ascending: false });
  return (data ?? []).map((d) => ({
    key: d.key,
    label: d.label,
    lens: d.lens as ReviewFlagDef["lens"],
    severity: d.severity,
    guidance: d.guidance,
    rationale: d.rationale,
    exampleCallIds: d.example_call_ids ?? [],
    proposedAt: d.proposed_at,
  }));
}

/** An active (or retired) rubric flag + its human track record, for the checklist. */
export type ChecklistDef = Pick<
  ReviewFlagDef,
  "key" | "label" | "lens" | "severity" | "guidance"
> & { active: boolean };

export type ChecklistFlag = ChecklistDef & {
  confirmed: number;
  rejected: number;
};

/** Join non-candidate defs to their confirmed/rejected tallies. Pure. Active
 *  flags first (both groups keep def order), so the running checklist leads and
 *  retired flags trail. Flag rows with no matching def are ignored. */
export function shapeChecklist(
  defs: ChecklistDef[],
  rows: { flag_key: string | null; status: string }[],
): ChecklistFlag[] {
  const conf = new Map<string, number>();
  const rej = new Map<string, number>();
  for (const r of rows) {
    if (!r.flag_key) continue;
    if (r.status === "confirmed")
      conf.set(r.flag_key, (conf.get(r.flag_key) ?? 0) + 1);
    else if (r.status === "rejected")
      rej.set(r.flag_key, (rej.get(r.flag_key) ?? 0) + 1);
  }
  const shaped = defs.map((d) => ({
    ...d,
    confirmed: conf.get(d.key) ?? 0,
    rejected: rej.get(d.key) ?? 0,
  }));
  return [
    ...shaped.filter((f) => f.active),
    ...shaped.filter((f) => !f.active),
  ];
}

/** Load the checklist: every non-candidate flag + its confirm/reject tallies.
 *  Paginates call_review_flags (PostgREST 1000-row cap) and tallies in JS — no
 *  group-by view needed. Admin-gated via the caller's RLS client. */
export async function fetchChecklistFlags(
  client: ServerClient,
): Promise<ChecklistFlag[]> {
  const { data: defs } = await client
    .from("review_flag_defs")
    .select("key, label, lens, severity, guidance, active")
    .eq("is_candidate", false)
    .order("severity", { ascending: true })
    .order("label", { ascending: true });

  const rows: { flag_key: string | null; status: string }[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client
      .from("call_review_flags")
      .select("flag_key, status")
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) break;
    const page = data ?? [];
    for (const r of page) rows.push({ flag_key: r.flag_key, status: r.status });
    if (page.length < PAGE) break;
  }
  return shapeChecklist((defs ?? []) as ChecklistDef[], rows);
}
