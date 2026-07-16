"use server";

import { revalidatePath } from "next/cache";

import { createClient as createAdminClient } from "@supabase/supabase-js";

import type { Database, Json } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";
import { chunk } from "./chunk";
import { PASS2_MODEL } from "./openai";
import {
  AGENT_PROMPT_COLUMNS,
  applyPromptEdits,
  draftPromptSuggestion,
  loadApprovedFlags,
  resolveCurrentAgentPrompt,
  writeAgentPrompt,
  type AgentPromptRow,
} from "./suggest";
import type { PromptEdit } from "./types";

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

/** Mark (or unmark) many calls as human-reviewed in one go. Admin-only. Stamps
 *  reviewed_by/at (or clears them on reopen) so bucket "unreviewed" counts drop.
 *  Chunked so a big bucket (or a whole-set select-all) never blows the URI /
 *  1,000-row limits. Returns how many review rows were updated. */
export async function markCallsReviewed(input: {
  callIds: string[];
  reviewed: boolean;
}): Promise<{ error: string | null; updated: number }> {
  const adminId = await currentAdminId();
  if (!adminId) return { error: "Admins only.", updated: 0 };
  const ids = [...new Set(input.callIds)].filter(Boolean);
  if (ids.length === 0) return { error: null, updated: 0 };

  const db = adminClient();
  const patch = {
    reviewed_by: input.reviewed ? adminId : null,
    reviewed_at: input.reviewed ? new Date().toISOString() : null,
  };
  let updated = 0;
  for (const batch of chunk(ids)) {
    const { data, error } = await db
      .from("call_reviews")
      .update(patch)
      .in("call_id", batch)
      .select("call_id");
    if (error) return { error: "Could not update review state.", updated };
    updated += data?.length ?? 0;
  }
  revalidatePath("/calls");
  revalidatePath("/reporting");
  return { error: null, updated };
}

/** Mark (or unmark) a single call reviewed. Admin-only. Thin wrapper over the
 *  bulk path so there's one code path to reason about. */
export async function markCallReviewed(input: {
  callId: string;
  reviewed: boolean;
}): Promise<{ error: string | null }> {
  const { error } = await markCallsReviewed({
    callIds: [input.callId],
    reviewed: input.reviewed,
  });
  return { error };
}

/** Mark every call in a bucket reviewed — i.e. every call carrying `flagKey` as
 *  confirmed or needs_review. Admin-only. Backs the Call Review tab's per-bucket
 *  "Mark all reviewed" button. Resolves the ids PK-ordered + paginated (a bucket
 *  can exceed 1,000 rows), then delegates to the chunked bulk update. */
export async function markBucketReviewed(input: {
  flagKey: string;
  reviewed?: boolean;
}): Promise<{ error: string | null; updated: number }> {
  if (!(await currentAdminId())) return { error: "Admins only.", updated: 0 };
  const key = input.flagKey.trim();
  if (!key) return { error: "No bucket specified.", updated: 0 };

  const db = adminClient();
  const ids: string[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("call_review_flags")
      .select("call_id")
      .eq("flag_key", key)
      .in("status", ["confirmed", "needs_review"])
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) return { error: "Could not load the bucket.", updated: 0 };
    const rows = data ?? [];
    for (const r of rows) if (r.call_id) ids.push(r.call_id);
    if (rows.length < PAGE) break;
  }
  return markCallsReviewed({
    callIds: ids,
    reviewed: input.reviewed ?? true,
  });
}

/** Confirm or reject a single AI flag. Admin-only. Rejecting drops it out of its
 *  bucket (buckets only count confirmed + needs_review). Also stamps WHO decided
 *  and WHEN — the AI writes status='confirmed' on its own, so curated_at is what
 *  marks a HUMAN decision (only human-approved flags may feed prompt
 *  suggestions). */
export async function setFlagStatus(input: {
  flagId: string;
  status: "confirmed" | "rejected";
}): Promise<{ error: string | null }> {
  const adminId = await currentAdminId();
  if (!adminId) return { error: "Admins only." };
  const { error } = await adminClient()
    .from("call_review_flags")
    .update({
      status: input.status,
      curated_by: adminId,
      curated_at: new Date().toISOString(),
    })
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

/** Turn an active flag off (retire — Pass 1 stops checking it, its bucket
 *  disappears) or back on. Admin-only. Scoped to non-candidate defs so it can
 *  never flip a discovery candidate. */
export async function setFlagActive(input: {
  key: string;
  active: boolean;
}): Promise<{ error: string | null }> {
  if (!(await currentAdminId())) return { error: "Admins only." };
  const { error } = await adminClient()
    .from("review_flag_defs")
    .update({ active: input.active })
    .eq("key", input.key)
    .eq("is_candidate", false);
  if (error) return { error: "Could not update the flag." };
  revalidatePath("/reporting");
  return { error: null };
}

/** Edit an active flag's wording/severity so it fires more precisely. Admin-only.
 *  Empty fields are left unchanged; severity clamps to 1-4. */
export async function updateFlagDef(input: {
  key: string;
  label?: string;
  guidance?: string;
  severity?: number;
}): Promise<{ error: string | null }> {
  if (!(await currentAdminId())) return { error: "Admins only." };
  const patch: Database["public"]["Tables"]["review_flag_defs"]["Update"] = {};
  if (input.label?.trim()) patch.label = input.label.trim();
  if (input.guidance?.trim()) patch.guidance = input.guidance.trim();
  if (typeof input.severity === "number")
    patch.severity = Math.min(4, Math.max(1, Math.round(input.severity)));
  if (Object.keys(patch).length === 0) return { error: null };
  const { error } = await adminClient()
    .from("review_flag_defs")
    .update(patch)
    .eq("key", input.key)
    .eq("is_candidate", false);
  if (error) return { error: "Could not save the flag." };
  revalidatePath("/reporting");
  return { error: null };
}

/** Draft a prompt-improvement suggestion for one (bucket, agent) from the
 *  human-approved examples. On success the contributing flags are stamped with
 *  the suggestion id so the same example never feeds two suggestions. */
export async function generatePromptSuggestion(input: {
  flagKey: string;
  agentId: string;
}): Promise<{ error: string | null }> {
  const adminId = await currentAdminId();
  if (!adminId) return { error: "Admins only." };
  const key = input.flagKey.trim();
  if (!key || !input.agentId) return { error: "Missing bucket or agent." };
  const db = adminClient();

  const { data: def } = await db
    .from("review_flag_defs")
    .select("key, label, guidance")
    .eq("key", key)
    .eq("is_candidate", false)
    .maybeSingle();
  if (!def) return { error: "That flag no longer exists." };

  const { data: agent } = await db
    .from("agents")
    .select(AGENT_PROMPT_COLUMNS)
    .eq("id", input.agentId)
    .maybeSingle();
  if (!agent) return { error: "That agent no longer exists." };

  const cur = await resolveCurrentAgentPrompt(agent as AgentPromptRow);
  if (!cur.prompt) return { error: cur.error };

  const flags = await loadApprovedFlags(db, key, input.agentId);
  if (flags.length === 0) {
    return {
      error:
        "No approved examples are available for this bucket and agent — confirm findings with “Looks right” first.",
    };
  }

  const drafted = await draftPromptSuggestion({
    prompt: cur.prompt,
    bucket: def,
    examples: flags.map((f) => ({ evidenceQuote: f.evidence_quote })),
  });
  if (!drafted.draft) return { error: drafted.error };

  const { data: created, error: insErr } = await db
    .from("review_prompt_suggestions")
    .insert({
      agent_id: input.agentId,
      flag_key: key,
      based_on_prompt: cur.prompt,
      proposed_prompt: drafted.draft.proposedPrompt,
      edits: drafted.draft.edits as unknown as Json,
      rationale: drafted.draft.rationale,
      summary: drafted.draft.summary,
      example_count: flags.length,
      model: PASS2_MODEL,
      cost: drafted.cost,
    })
    .select("id")
    .single();
  if (insErr || !created) return { error: "Could not save the suggestion." };

  await db
    .from("call_review_flags")
    .update({ suggestion_id: created.id })
    .in(
      "id",
      flags.map((f) => f.id),
    );
  revalidatePath("/reporting");
  return { error: null };
}

/** Apply an approved suggestion to the live agent. Marija may have reworded the
 *  new text (editedTexts, aligned with the stored edits) — anchors are fixed.
 *  Refuses when the live prompt no longer matches what the suggestion was
 *  drafted against. ElevenLabs first; log + statuses only after success. */
export async function applyPromptSuggestion(input: {
  suggestionId: string;
  editedTexts?: string[];
}): Promise<{ error: string | null }> {
  const adminId = await currentAdminId();
  if (!adminId) return { error: "Admins only." };
  const db = adminClient();

  const { data: s } = await db
    .from("review_prompt_suggestions")
    .select("*")
    .eq("id", input.suggestionId)
    .maybeSingle();
  if (!s) return { error: "That suggestion no longer exists." };
  if (s.status !== "proposed") {
    return { error: "This suggestion was already decided." };
  }

  let edits = s.edits as unknown as PromptEdit[];
  if (input.editedTexts) {
    if (input.editedTexts.length !== edits.length) {
      return { error: "Edited texts don't match the suggestion." };
    }
    edits = edits.map((e, i) => ({ ...e, text: input.editedTexts![i] }));
  }
  const applied = applyPromptEdits(s.based_on_prompt, edits);
  if (!applied.result) return { error: applied.error };
  const finalPrompt = applied.result.trim();

  const { data: agent } = await db
    .from("agents")
    .select(AGENT_PROMPT_COLUMNS)
    .eq("id", s.agent_id)
    .maybeSingle();
  if (!agent) return { error: "That agent no longer exists." };

  const cur = await resolveCurrentAgentPrompt(agent as AgentPromptRow);
  if (!cur.prompt) return { error: cur.error };
  if (cur.prompt !== s.based_on_prompt) {
    return {
      error:
        "The agent's prompt changed since this suggestion was drafted. Dismiss it and generate a fresh one.",
    };
  }

  const w = await writeAgentPrompt(db, agent as AgentPromptRow, finalPrompt);
  if (w.error) return { error: w.error };

  const { data: def } = await db
    .from("review_flag_defs")
    .select("label")
    .eq("key", s.flag_key)
    .maybeSingle();
  await db.from("agent_prompt_log").insert({
    agent_id: s.agent_id,
    changed: "Changed",
    what_changed: s.summary,
    why: `${s.rationale} — based on ${s.example_count} approved example(s) in "${def?.label ?? s.flag_key}".`,
    full_prompt: finalPrompt,
  });
  await db
    .from("review_prompt_suggestions")
    .update({
      status: "applied",
      edits: edits as unknown as Json,
      proposed_prompt: finalPrompt,
      decided_by: adminId,
      decided_at: new Date().toISOString(),
      applied_at: new Date().toISOString(),
    })
    .eq("id", s.id);
  revalidatePath("/reporting");
  return { error: null };
}

/** Dismiss a proposed suggestion. Its examples return to the available pool. */
export async function dismissPromptSuggestion(input: {
  suggestionId: string;
}): Promise<{ error: string | null }> {
  const adminId = await currentAdminId();
  if (!adminId) return { error: "Admins only." };
  const db = adminClient();
  const { data, error } = await db
    .from("review_prompt_suggestions")
    .update({
      status: "dismissed",
      decided_by: adminId,
      decided_at: new Date().toISOString(),
    })
    .eq("id", input.suggestionId)
    .eq("status", "proposed")
    .select("id");
  if (error || !data || data.length === 0) {
    return { error: "Could not dismiss the suggestion." };
  }
  await db
    .from("call_review_flags")
    .update({ suggestion_id: null })
    .eq("suggestion_id", input.suggestionId);
  revalidatePath("/reporting");
  return { error: null };
}

/** Restore the pre-suggestion prompt. Only valid while the live prompt still
 *  equals what this suggestion produced (nothing else changed it since) — the
 *  same never-overwrite-unseen-state rule as apply. Its examples return to the
 *  available pool. */
export async function revertPromptSuggestion(input: {
  suggestionId: string;
}): Promise<{ error: string | null }> {
  const adminId = await currentAdminId();
  if (!adminId) return { error: "Admins only." };
  const db = adminClient();

  const { data: s } = await db
    .from("review_prompt_suggestions")
    .select("*")
    .eq("id", input.suggestionId)
    .maybeSingle();
  if (!s) return { error: "That suggestion no longer exists." };
  if (s.status !== "applied")
    return { error: "Only applied changes can be reverted." };

  const { data: agent } = await db
    .from("agents")
    .select(AGENT_PROMPT_COLUMNS)
    .eq("id", s.agent_id)
    .maybeSingle();
  if (!agent) return { error: "That agent no longer exists." };

  const cur = await resolveCurrentAgentPrompt(agent as AgentPromptRow);
  if (!cur.prompt) return { error: cur.error };
  if (cur.prompt !== s.proposed_prompt) {
    return {
      error:
        "The prompt has changed again since this was applied — revert it manually in the agent editor instead.",
    };
  }

  const w = await writeAgentPrompt(
    db,
    agent as AgentPromptRow,
    s.based_on_prompt,
  );
  if (w.error) return { error: w.error };

  await db.from("agent_prompt_log").insert({
    agent_id: s.agent_id,
    changed: "Changed",
    what_changed: `Reverted: ${s.summary}`,
    why: "Manual revert from Reporting → Prompt improvements.",
    full_prompt: s.based_on_prompt,
  });
  await db
    .from("review_prompt_suggestions")
    .update({ status: "reverted", reverted_at: new Date().toISOString() })
    .eq("id", s.id);
  await db
    .from("call_review_flags")
    .update({ suggestion_id: null })
    .eq("suggestion_id", s.id);
  revalidatePath("/reporting");
  return { error: null };
}
