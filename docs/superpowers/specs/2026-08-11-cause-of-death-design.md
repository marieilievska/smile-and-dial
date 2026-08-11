# Cause of Death — design spec

**Date:** 2026-08-11
**Status:** Approved concept, pending spec review → implementation plan

## 1. Goal

For the leads we work but don't win, answer **why** and **how many** — quantified and specific. Not just "we lost 400 leads," but: 120 never answered, 90 stuck at the gatekeeper, 140 reached the decision-maker and said no — and of those, 60 on **price**, 40 **already using a competitor** (which one), 25 **no need**, with the **exact quote** for each. Turn the failure column into an actionable diagnosis of the pitch, the offer, and the list.

## 2. Where it lives

A new **"Cause of Death" tab in the Reporting hub** (`/reporting?tab=cause-of-death`).

- **Admin-only** (Reporting is already admin-gated: `src/app/(app)/reporting/page.tsx` redirect + `nav.ts`).
- **Per-campaign scope** via the existing `ScopePicker` (`?scope=all|campaign:<id>`), model `src/lib/agent-analytics/scope.ts`.
- **Shareable** via the existing token-gated page (`src/app/share/reporting/[token]/page.tsx`) — add one render `case`.
- **CSV export** via the existing `ExportCsvButton`.
- **Window:** the same fixed 30-day window as the rest of Reporting to start (widening to a date range is a later, isolated change).

Chosen over an Analytics section because Reporting is the admin-only, per-campaign, shareable surface, and its query layer already loads the call rows we need.

## 3. The funnel model (one cause per lead)

### Cohort (denominator)

Distinct **leads with ≥1 outbound call in the 30-day window**, scoped to the selected campaign(s). "Of the businesses we actually worked, here's what happened to each." Deduped to distinct `lead_id` (the same distinct-business basis goals already use — `src/lib/analytics/stats.ts::computeKpis` lines ~186-231).

### One primary cause per lead = the furthest stage it reached

A lead has many calls with different outcomes. Its cause is the **most-advanced** thing that happened to it, not the most recent or most common. A lead voicemailed 3× then reached on call 4 where the decision-maker said "too expensive" = **DM said no → price**, never "voicemail."

Assignment priority (first match wins), derived from the lead's `status`, `decision_maker_reached`, retry state, and the set of its calls' `outcome` values (`src/lib/calls/outcomes.ts` groupings):

**WON (shown for contrast, not a death)**

1. `goal_met` — status `goal_met`/`transferred_to_human`, or any `goal_met` call.

**FINAL LOSSES** 2. **Opted out** — status `dnc` or any `dnc` outcome. 3. **DM said no** — any `not_interested` outcome (the decision-maker declined). → objection breakdown. 4. **Blocked by gatekeeper** — reached a human but never the DM (`gatekeeper` outcome present, `decision_maker_reached=false`, no `not_interested`) AND the lead is finished (status `resting`, or retries exhausted). 5. **Bad number** — `invalid_number` as the best outcome reached. 6. **Other** — `language_barrier` / `ai_receptionist` / `ai_error` as the best outcome. 7. **Never reached anyone** — only `NO_HUMAN` outcomes (`voicemail`/`no_answer`/`busy`/`failed`) AND retries exhausted (no further attempts scheduled).

**STILL IN PLAY (not dead yet)** 8. **Callback booked** — status `callback` (a pending callback). 9. **Mid-follow-up** — status `ready_to_call` with attempts remaining / a future `next_call_at`, only non-terminal outcomes so far.

The UI groups 2–7 under **Final losses**, 8–9 under **Still in play**, and shows **Won** alongside for contrast. Exact status/outcome enum values are enumerated in the implementation plan; the priority order above is the contract.

## 4. The objection engine (new, Phase 2)

The "DM said no" bucket is the valuable part. There is **no** objection data today (the old Call Reviewer that captured it was deleted 2026-08-06), but every connected call's full transcript is saved in `calls.transcript_json`.

### Extraction

A **background worker** (a cron-fired endpoint, gated by `DIALER_TICK_SECRET`, following the `smart-lists/refresh` + review-cron pattern — cleaner than bolting onto the live post-call webhook, and it backfills naturally) runs an **OpenAI `gpt-5.4-mini`** pass (the model already used by `src/lib/openai/summary-merger.ts`) over the transcript of each **conversation call that hasn't been analyzed yet**.

- **Scope of what gets analyzed:** calls whose `outcome ∈ CONVERSATION_OUTCOMES` (real two-way talk) and `goal_met = false` and `objection_analyzed_at IS NULL`. Non-conversations (voicemail/no-answer) are, by definition, fully explained by `outcome` alone — never analyzed. This bounds cost tightly. (Analyzing overcome objections on `goal_met` calls is a future extension.)
- **Runs over all existing qualifying transcripts (immediate backfill)** and each new one as it lands, draining the queue a batch per run. Idempotent via the `objection_analyzed_at` guard.
- **Customer-only clause** (mirror `CUSTOMER_ONLY_CLAUSE` in `src/lib/agents/data-collection.ts`) so it extracts the **customer's** objection, not the agent's paraphrase.
- **Cost** folded into `calls.cost_breakdown.openai` (same as summaries).

### Output (strict JSON per call, stored on the call)

- `objection_category` — one of the fixed taxonomy below (or `null` if none/ambiguous).
- `objection_specific` — one short line: "not interested in **what**" (e.g. "already using Podium", "too pricey for a 2-chair salon", "no time this quarter").
- `objection_quote` — the customer's verbatim line (≤ ~200 chars).
- `objection_analyzed_at` — timestamp, set even when no objection is found (so it's never re-analyzed).

### Taxonomy (tunable)

`price` · `already_have_solution` (→ competitor in `specific`) · `no_need` · `bad_timing` · `happy_with_current` · `confused_by_offer` · `distrust_spam` · `brush_off` · `other`.

### Storage

New nullable columns on `calls`: `objection_category`, `objection_specific`, `objection_quote`, `objection_analyzed_at`, plus a **partial index** for the worker's queue (`where objection_analyzed_at is null and goal_met = false and outcome in (…conversation…)`). Kept on `calls` (not a sidecar table) so an objection sits next to the outcome it belongs to and joins cheaply for the drill-down.

## 5. The screen

- **Funnel scoreboard** (top): each cause as a horizontal bar with **count + % of worked leads**, grouped **Final losses / Still in play**, colored by severity — reuse the styling of `OutcomeBreakdown` (`src/app/(app)/analytics/charts.tsx:146`) and `outcomeBadgeVariant` (`src/lib/outcome-style.ts`). **Won** shown alongside for contrast.
- **Objection breakdown**: the "DM said no" bar expands into a bar chart of objection categories (price / competitor / no-need / bad-timing / confused …), each with a count.
- **Drill-down**: click any cause or objection → the list of leads in it, each showing company, the one-line **"not interested in what"**, the **verbatim quote**, and a link to the lead detail / transcript. This is what makes it "really good."
- **Scope + explainer**: per-campaign via `ScopePicker`; the objection breakdown is richest per single campaign, so show a `ReportingNotice`-style explainer (pattern: `field-detect.ts` `voiceUnavailableReason`) when scope = all campaigns. Raw funnel causes work fine across all campaigns.

## 6. Data flow & query layer

- New `fetchCauseOfDeath(supabase, scope)` in `src/lib/agent-analytics/report-data.ts`. It gathers, for the cohort (leads with ≥1 call in-window): each lead's `status`, `decision_maker_reached`, retry state, and its calls' `outcome` / `goal_met` / objection fields. **Must paginate around the 1000-row cap** with `.range()` loops like `fetchDashboardKpis` (report-data.ts:134-153) — `.limit(2000)` does NOT bypass the cap on this project. Chunk any `.in(id, …)` lookups at ≤200 (`src/lib/leads/chunk.ts`).
- New pure `computeCauseOfDeath(leadsWithCalls)` in a new `src/lib/agent-analytics/cause-of-death.ts` → `{ causeCounts, objectionCounts, perLeadCause[] }`. Pure = unit-testable without a DB.
- Every fetcher takes the `supabase` client as its first arg so the in-app admin client and the share page's service-role client share identical logic (existing convention).

## 7. Components to reuse (don't rebuild)

`OutcomeBreakdown` / `FunnelChart` (`analytics/charts.tsx`), `KpiTile` (`analytics/kpi-tile.tsx`), `outcomeLabel`/`OUTCOME_LABELS` (`src/lib/labels.ts`), `outcomeBadgeVariant` (`src/lib/outcome-style.ts`), `ScopePicker` + `ReportingNotice`, `ExportCsvButton`, outcome groupings from `src/lib/calls/outcomes.ts`.

## 8. Rollout — two PRs (one per phase)

- **Phase 1 — the funnel, from existing data (no AI).** Migration: none. New tab + `fetchCauseOfDeath` + `computeCauseOfDeath` + funnel scoreboard + drill-down to leads by cause. The "DM said no" bucket shows its count and drills to the leads, with the objection breakdown showing "analysis coming" until Phase 2. Immediate value, zero AI cost.
- **Phase 2 — the objection engine.** Migration (objection columns + index) → the worker + cron + backfill → the objection breakdown chart + specifics + quotes in the drill-down.

## 9. Testing

- **Pure functions unit-tested:** `computeCauseOfDeath` (cause assignment from a lead's status + calls; the priority order; dead-vs-in-play split; distinct-lead dedup) and the objection aggregation. Cover the tie cases (voicemail+not_interested → DM said no; dnc precedence; gatekeeper final vs in-play).
- **Objection extraction:** the pure prompt-build + strict-JSON-parse function unit-tested; the worker smoke-tested against a handful of real transcripts.
- **Constraint:** no E2E test accounts exist (only `marie@referrizer.com`); use pure unit tests + read-only vitest against prod for any data-layer check (see `[[project-ci-test-db]]`). Verify with `tsc` + `eslint` + `vitest` locally.

## 10. Gotchas (from the codebase)

1. **1000-row cap** — paginate with `.range()`; `.limit(2000)` is a lie here.
2. **RSC client-value imports** — keep `reporting-tabs.tsx` a plain (non-`"use client"`) module; interactive bits are their own client files; row types live in `report-data.ts` for `import type`.
3. **Per-campaign scoping** for objections (custom context differs per agent) — explainer when scope = all.
4. **ET-day boundaries** — use the `agent-analytics` ET helpers, consistent with the Dashboard.
5. **Share page** — add the new tab's `case` to the share render switch; it appears in the share nav automatically unless excluded.
6. **Denominator discipline** — causes are per **lead** (distinct business); don't mix with per-call counts.
