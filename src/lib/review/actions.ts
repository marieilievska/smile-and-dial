"use server";

import { revalidatePath } from "next/cache";

import { createClient as createAdminClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";

type SupabaseAdmin = ReturnType<typeof createAdminClient<Database>>;

function adminClient(): SupabaseAdmin {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  return createAdminClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** Current signed-in admin's id, or null. Review writes are admin-only. */
async function currentAdminId(): Promise<string | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  return me?.role === "admin" ? user.id : null;
}

/** One flag on a call, for the modal's review panel. */
export type CallReviewFlag = {
  id: string;
  flagKey: string;
  label: string;
  lens: string;
  evidenceQuote: string | null;
  confidence: number | null;
  status: "confirmed" | "needs_review" | "rejected";
};

export type CallReviewDetail = {
  status: string;
  reachedHuman: boolean;
  needsReview: boolean;
  reviewedAt: string | null;
  flags: CallReviewFlag[];
};

/**
 * Load a call's review row + its flags (joined to defs for labels). Admin-only.
 * Returns `{ review: null }` when the call has no review row yet (e.g. an old
 * call from before the reviewer went live) — the modal then shows nothing.
 */
export async function getCallReview(
  callId: string,
): Promise<{ review: CallReviewDetail | null; error: string | null }> {
  if (!(await currentAdminId())) return { review: null, error: "Admins only." };
  const admin = adminClient();

  const { data: review } = await admin
    .from("call_reviews")
    .select("status, reached_human, needs_review, reviewed_at")
    .eq("call_id", callId)
    .maybeSingle();
  if (!review) return { review: null, error: null };

  const { data: flagRows } = await admin
    .from("call_review_flags")
    .select("id, flag_key, evidence_quote, confidence, status")
    .eq("call_id", callId);

  const keys = [...new Set((flagRows ?? []).map((f) => f.flag_key))];
  const defByKey = new Map<string, { label: string; lens: string }>();
  if (keys.length > 0) {
    const { data: defs } = await admin
      .from("review_flag_defs")
      .select("key, label, lens")
      .in("key", keys);
    for (const d of defs ?? [])
      defByKey.set(d.key, { label: d.label, lens: d.lens });
  }

  const flags: CallReviewFlag[] = (flagRows ?? []).map((f) => ({
    id: f.id,
    flagKey: f.flag_key,
    label: defByKey.get(f.flag_key)?.label ?? f.flag_key,
    lens: defByKey.get(f.flag_key)?.lens ?? "",
    evidenceQuote: f.evidence_quote,
    confidence: f.confidence,
    status: f.status as CallReviewFlag["status"],
  }));

  return {
    review: {
      status: review.status,
      reachedHuman: review.reached_human,
      needsReview: review.needs_review,
      reviewedAt: review.reviewed_at,
      flags,
    },
    error: null,
  };
}

/** Mark (or unmark) a call as human-reviewed. Admin-only. Stamps reviewed_by/at
 *  so the bucket "unreviewed" counts drop. */
export async function markCallReviewed(input: {
  callId: string;
  reviewed: boolean;
}): Promise<{ error: string | null }> {
  const adminId = await currentAdminId();
  if (!adminId) return { error: "Admins only." };
  const { error } = await adminClient()
    .from("call_reviews")
    .update({
      reviewed_by: input.reviewed ? adminId : null,
      reviewed_at: input.reviewed ? new Date().toISOString() : null,
    })
    .eq("call_id", input.callId);
  if (error) return { error: "Could not update review state." };
  revalidatePath("/calls");
  revalidatePath("/reporting");
  return { error: null };
}

/** Confirm or reject a single AI flag. Admin-only. Rejecting drops it out of its
 *  bucket (buckets only count confirmed + needs_review). */
export async function setFlagStatus(input: {
  flagId: string;
  status: "confirmed" | "rejected";
}): Promise<{ error: string | null }> {
  if (!(await currentAdminId())) return { error: "Admins only." };
  const { error } = await adminClient()
    .from("call_review_flags")
    .update({ status: input.status })
    .eq("id", input.flagId);
  if (error) return { error: "Could not update the flag." };
  revalidatePath("/calls");
  revalidatePath("/reporting");
  return { error: null };
}

/** Approve a discovery candidate: it joins the live rubric (active=true,
 *  is_candidate=false) and Pass 1 will check it on future calls. Admin-only. */
export async function approveCandidate(input: {
  key: string;
}): Promise<{ error: string | null }> {
  if (!(await currentAdminId())) return { error: "Admins only." };
  const { error } = await adminClient()
    .from("review_flag_defs")
    .update({ active: true, is_candidate: false, dismissed_at: null })
    .eq("key", input.key)
    .eq("is_candidate", true);
  if (error) return { error: "Could not approve the suggestion." };
  revalidatePath("/reporting");
  return { error: null };
}

/** Dismiss a candidate: kept (not deleted) with dismissed_at set so the hourly
 *  pass is told not to re-propose it. Admin-only. */
export async function dismissCandidate(input: {
  key: string;
}): Promise<{ error: string | null }> {
  if (!(await currentAdminId())) return { error: "Admins only." };
  const { error } = await adminClient()
    .from("review_flag_defs")
    .update({ dismissed_at: new Date().toISOString() })
    .eq("key", input.key)
    .eq("is_candidate", true);
  if (error) return { error: "Could not dismiss the suggestion." };
  revalidatePath("/reporting");
  return { error: null };
}
