# Per-campaign call summaries: scoping + factual guidance + manual edit — Design

**Date:** 2026-07-01
**Status:** Design approved, pending spec review

## Problem

The context we pass to ElevenLabs at call start (`{{last_call_summary}}`,
`{{last_callback_notes}}`) is built from the lead's **single, lead-level** rolling
`ai_summary` and from callback origin calls — **not scoped to the campaign**. Two
concrete failures:

1. **Cross-campaign bleed.** A lead called under campaign 1 accumulates notes; when
   campaign 2 calls the same lead, campaign 1's notes are handed to the campaign 2
   agent. Operators don't want one campaign's context leaking into another's call.
2. **Stale/wrong forward guidance.** The rolling summary bakes in "next time do X"
   instructions (the merger prompt literally asks for a `Next time: Z` line). These
   go wrong — e.g. "owner is never in" yet the note says "email the owner and
   reference it next time," when we should target the **manager**. A manual edit
   exists but depends on catching it in time.

## Decisions (approved)

- **A. Per-campaign memory.** The rolling summary + callback notes passed to a call
  come only from prior calls of the **same campaign**. A lead's first call under a
  new campaign starts fresh.
- **B. Facts-only summary.** The rolling summary records what _happened_ + durable
  facts (who's reachable, who handles leads) with **no prescriptive "next time do
  X."** The agent decides who to target from the facts + its own prompt.
- **C. Manual edit safety valve.** Operators can view/edit/clear a lead's
  per-campaign summary from the lead page, for the few things that slip past B.
- **All three ship together** (one spec, one plan).

## Non-goals (YAGNI)

- Reshaping ElevenLabs' own per-call `summary` (that's EL's analysis output; we
  reshape only OUR rolling merge, which is what's passed as `last_call_summary`).
- Editing the agents' system prompts for target-selection strategy (facts-only
  summaries should let the agent behave correctly; agent-prompt tuning is a
  separate lever if still needed).
- Cross-campaign "shared facts" (rejected in favor of clean per-campaign
  isolation).
- Dropping `leads.ai_summary`. It's **kept and repurposed** as a denormalized
  "latest campaign summary" (the merger copies the newest campaign's merged
  summary into it) so the leads-list column, CSV export, lead-merge, and the
  legacy inbound webhook keep working **unchanged**. It is simply no longer the
  source for CALL CONTEXT (that's per-campaign now). No column drop, no 2-phase
  migration, no rework of those surfaces.

## Current state (what changes)

- `leads.ai_summary` — single rolling summary, LLM-merged after each call.
- `src/lib/openai/summary-merger.ts` `mergeLeadSummary({ leadId, latestSummary })`
  — reads `leads.ai_summary`, pulls the last 5 call summaries **for the lead
  (any campaign)**, merges via gpt-4o-mini (prompt asks for `Next time: Z`),
  writes `leads.ai_summary`. Called from the post-call webhook (step 39).
- `src/lib/elevenlabs/conversation-init.ts` `buildVarsForCall` — reads
  `leads.ai_summary` → `last_call_summary`; `last_callback_notes` = the pending
  callback's originating call `summary` (any campaign).
- `src/lib/leads/recompute-call-state.ts` — clears/rebuilds `leads.ai_summary` on
  reset/delete-calls.
- Lead page shows the single `leads.ai_summary` in an "AI summary" card
  (`lead-page-client.tsx` / `lead-detail-parts.tsx`).
- `src/lib/leads/lead-actions.ts` has a name-correction scrub of `ai_summary`.

## Components & changes

### 1. Schema — `lead_campaign_summaries` (migration, additive)

New table:

```sql
create table lead_campaign_summaries (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  campaign_id uuid not null references campaigns(id) on delete cascade,
  ai_summary text,
  updated_at timestamptz not null default now(),
  unique (lead_id, campaign_id)
);
```

RLS enabled, mirroring `lead_custom_values`: service-role full access; a
`select` policy letting a signed-in user read rows for leads they own
(join `leads.owner_id = auth.uid()`), plus admins. Writes happen via the
service-role client (merger, reset, manual-edit action).

**Backfill (in the migration):** for each lead with a non-empty `ai_summary`,
insert one row keyed to the campaign of that lead's most recent call
(`calls` ordered by `started_at desc`), so existing context isn't lost. Leads
with no calls / no summary are skipped. `leads.ai_summary` is left in place
(not dropped; simply no longer read for call context).

Apply with `supabase db push --linked` BEFORE the code deploy (additive — safe).

### 2. Per-campaign merge (A) + facts-only prompt (B) — `summary-merger.ts`

`mergeLeadSummary({ leadId, campaignId, latestSummary })`:

- Read the existing summary from `lead_campaign_summaries` where `(lead_id,
campaign_id)` (empty if none).
- Pull the last 5 call summaries **for this lead AND this campaign**
  (`.eq("campaign_id", campaignId)`).
- Merge (OpenAI or mock) and **upsert** `lead_campaign_summaries` on
  `(lead_id, campaign_id)`.
- **Also write the merged value to `leads.ai_summary`** (the denormalized
  "latest campaign summary") so the leads-list column + CSV export keep a
  glanceable summary. Those surfaces, lead-merge, and the legacy inbound webhook
  are otherwise **unchanged** — they keep reading `leads.ai_summary`.
- **Prompt (B):** rewrite so the note is **facts-only** — keep "who/what we know",
  "what happened / what the lead said", "their stated pain (only if they raised
  it)", "commitment (only if explicit)", AND a factual **reachability** line
  (e.g. "owner is never on-site; the manager, Jane, handles leads; email captured
  is X"). **Remove the prescriptive `Next time: Z`** line and the "what the next
  caller should DO" instruction — replaced by stating reachability/roles as facts
  so the agent chooses the target itself. Keep the strong attribution guardrails
  already in the system prompt.

Post-call webhook (step 39) passes the call's `campaign_id` to `mergeLeadSummary`.
(If a call has no `campaign_id` — shouldn't happen for campaign dials — skip the
merge.)

### 3. Per-campaign read (A) — `conversation-init.ts` `buildVarsForCall`

- `last_call_summary`: read `lead_campaign_summaries.ai_summary` for
  `(call.lead_id, call.campaign_id)`; empty when there's no row (fresh start in a
  new campaign). Keep the recency prefix.
- `last_callback_notes`: only populate when the pending callback's originating
  call's `campaign_id` === `call.campaign_id` (fetch the originating call's
  `campaign_id` alongside its `summary`); otherwise empty.

### 4. Reset/recompute (A) — `recompute-call-state.ts`

On reset / delete-calls for a lead, also delete the lead's
`lead_campaign_summaries` rows (they rebuild from subsequent calls). Do NOT
attempt a per-campaign rebuild here — clearing is sufficient and matches the
"rolling memory rebuilds as calls happen" model. Keep clearing/rebuilding
`leads.ai_summary` too (it's the latest-summary convenience for the list/CSV).

### 5. Lead page display (A) + manual edit (C)

- The lead page fetches the lead's `lead_campaign_summaries` (join campaign name)
  and renders a **per-campaign summary** section — one card per campaign the lead
  has been called under: campaign name + summary text + an **Edit** and **Clear**
  control (admin/owner). Replaces the single "AI summary" hero card. When a lead
  has no per-campaign summaries yet, show a muted empty state.
- New server actions in `lead-actions.ts` (admin/owner-gated, service-role write,
  `revalidatePath` the lead page): `updateLeadCampaignSummary({ leadId,
campaignId, summary })` updates the row's text; `clearLeadCampaignSummary({
leadId, campaignId })` deletes the row. Mirrors the existing custom-value edit
  pattern.
- The existing name-correction scrub (`lead-actions.ts`) is extended to scrub
  **both** the lead's `lead_campaign_summaries` rows AND `leads.ai_summary` (the
  latest copy), so corrected names don't linger in either.

## Data flow

Call placed → `conversation-init` reads the (lead, campaign) summary → passed as
`last_call_summary` → agent talks → post-call webhook merges the new call summary
into the (lead, campaign) row (facts-only) → next same-campaign call sees it; a
different campaign sees its own (or fresh). Operator can edit/clear any
(lead, campaign) summary from the lead page.

## Error / edge handling

- First call in a new campaign → no row → empty `last_call_summary` (fresh).
- Call with null `campaign_id` → skip the merge (no per-campaign row to write).
- OpenAI down → existing mock-merge fallback, now writing the per-campaign row.
- Backfill: leads with no calls or empty summary are skipped (no row).
- Manual edit: admin/owner only. **Edit** updates the row's `ai_summary` text;
  **Clear deletes the row** (so the next same-campaign call starts fresh, matching
  the reset model — no stale guidance survives a clear).

## Testing (Playwright live-env + unit)

- **Unit:** the facts-only merge prompt is hard to unit-test (LLM), but
  `mockMerge` output shape can be asserted; add a test that `mergeLeadSummary`
  writes to `lead_campaign_summaries` (mock mode) for the right (lead, campaign)
  and does NOT touch a different campaign's row.
- **Contract (live-env):** seed a lead with calls under two campaigns; assert
  `buildVarsForCall` returns campaign-1 context for a campaign-1 call and
  campaign-2 (or empty) for a campaign-2 call; assert the lead page shows a
  per-campaign summary card and the edit/clear action updates only that row.
- Verify the not-connected/legacy paths still work.

## Verification gates

`npx tsc --noEmit`, `npx eslint`, `npm run build` — clean (only the 3 pre-existing
`twilio-*.spec.ts` baseline errors). **Migration:** additive; apply with
`supabase db push --linked` before deploy.
