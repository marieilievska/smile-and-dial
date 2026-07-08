# Call Reviewer — Design

**Date:** 2026-07-05
**Status:** Design approved (pending written-spec review)

## Problem

We're scaling to **10,000+ outbound calls/day**. No human can listen to, or even skim the transcripts of, that volume — yet real problems hide in the calls: agent mistakes, technical bugs (e.g. the Evolve Thermal Spa booking that said "unavailable" then booked the same slot), missed hot leads, and customer signals worth acting on. We need an automated reviewer that reads every real conversation, **accurately** flags what happened, and groups calls into small reviewable buckets ("booking failed — 15 calls", "price objection — 50 calls") so a human reviews _what matters_ instead of everything.

## Decisions (approved)

- **Four review lenses, maximum coverage** (don't miss anything): agent quality/mistakes, missed opportunities/wins, bugs/failures, customer signals (VoC).
- **Hybrid grouping**: a fixed, data-driven **flag rubric** (high accuracy) PLUS an hourly **discovery pass** that proposes new candidate flags for recurring things the rubric missed.
- **Two-pass verification** for accuracy: Pass 1 extracts flags; Pass 2 independently re-checks each; disagreements are surfaced as **"needs your eyes"** rather than silently trusted.
- **Live / rolling**: each call is analyzed within minutes of completion; bucket counts update through the day.
- **Only human-reached conversations get the deep pass.** Voicemail / no-answer / instant-hangup get a cheap auto-bucket (`no_conversation`) and skip the LLM passes.
- **Models (OpenAI, stored as config):** Pass 1 = `5.4-mini`; Pass 2 (verify) = `5.4`. Model + cost logged per call so they're tunable without code changes.
- **Bucket drill-in reuses the existing Calls screen**: a bucket deep-links to the Calls list filtered to those calls; the operator reviews call-by-call with the existing call detail modal.

## Non-goals (YAGNI)

- Reviewing voicemails / no-answers in depth (auto-bucketed only).
- Auto-remediation (the reviewer surfaces; humans/other features act).
- A bespoke call viewer (we reuse `/calls` + the call detail modal).
- Real-time _mid-call_ intervention (this is post-call).
- Scoring agents beyond the existing 0–10 quality score (we flag specific events, not re-score).

## Architecture — a queue-driven, live pipeline

```
call completes → EL post-call webhook (existing: writes disposition/score/summary/transcript)
      │
      ├─ reached a human?  no → call_reviews row status='done', flag 'no_conversation'
      │                    yes ↓
      └─ INSERT call_reviews (status='pending', reached_human=true)
                 │
   dialer-tick-style worker (pg_cron → secured endpoint), every ~1 min:
      claim a batch of 'pending' rows (compare-and-swap on status)
         │
         ├─ Pass 1 (5.4-mini): extract flags vs the active rubric → [{flag, evidence_quote, confidence}]
         ├─ Pass 2 (5.4): independently verify each proposed flag against the transcript
         │        agree+confident → confirmed;  disagree/low → needs_review
         ├─ UPSERT call_review_flags (one row per (call, flag))
         └─ call_reviews status='done', needs_review = any(flag.status='needs_review'), cost, models
                 │
   buckets = live query grouping call_review_flags by flag (joined to defs) with counts
                 │
   Review tab (Reporting hub): bucket list → deep-link into /calls filtered to the bucket

Hourly discovery job: sample recent calls (esp. low-flag ones) → propose candidate flags → review_flag_defs (is_candidate=true, active=false) → operator approves → active=true
```

All LLM work is off the call path (queue + worker), so 10k/day never blocks a dial and each call is processed within minutes.

## The flag rubric (starter set)

Fixed flags Pass 1 checks every conversation against. Each has a **lens** and **severity** (drives review priority). Data-driven (`review_flag_defs`); editable; grown by the discovery pass.

**🔴 Bugs / failures (high):** `booking_failed_then_recovered`, `tool_error`, `wrong_data_used`, `dead_air`, `dropped_midconversation`, `agent_looped`, `transfer_failed`

**🔴 Compliance / risk (high):** `dnc_not_honored`, `misleading_claim`, `overpromised`

**🟠 Agent quality / mistakes:** `wrong_info_given`, `fumbled_objection`, `rambled_unclear`, `pushy_or_rude`, `off_goal`, `didnt_confirm_details`, `awkward_delivery`

**🟡 Missed opportunities / wins:** `hot_lead_not_booked`, `decision_maker_no_ask`, `callback_promised_not_scheduled`, `goal_met_needs_followup`

**🟢 Customer signals / VoC (informational):** `price_objection`, `not_interested_reason`, `competitor_mentioned`, `software_mentioned`, `feature_or_need_request`, `strong_interest`, `confused_by_offer`

Every flag stores the **verbatim evidence quote** that triggered it, so a bucket shows _why_ each call is in it without replay.

## Data model (4 new tables)

**`review_flag_defs`** — the rubric.
`id uuid pk, key text unique, label text, lens text (bug|compliance|quality|opportunity|voc), severity int (1 high … 4 info), guidance text (analyzer prompt text for this flag), active bool default true, is_candidate bool default false, sort_order int, created_at`.
The Pass 1 prompt is built from `active` rows. Admin-managed; RLS admin-read, service-role writes (repo convention).

**`call_reviews`** — one row per analyzed call; doubles as the work queue.
`call_id uuid pk → calls(id) on delete cascade, status text (pending|analyzing|done|error), reached_human bool, needs_review bool default false, pass1_model text, pass2_model text, cost numeric, error text, reviewed_by uuid null, reviewed_at timestamptz null, created_at, analyzed_at`.

**`call_review_flags`** — the core; one row per (call, flag).
`id uuid pk, call_id uuid → calls(id) on delete cascade, flag_key text → review_flag_defs(key), evidence_quote text, confidence numeric, status text (confirmed|needs_review|rejected), created_at, unique(call_id, flag_key)`. Index on `(flag_key, status)` for bucket counts.

**Buckets** — not a table; a query grouping `call_review_flags` (status in confirmed/needs_review) by `flag_key`, joined to `review_flag_defs`, returning `{flag_key, label, lens, severity, total, unreviewed, needs_review}` for a date/campaign/agent window. A pinned **"Needs your eyes"** pseudo-bucket = all `status='needs_review'` flags across types.

## The two-pass analysis

- **Pass 1 (`5.4-mini`)** — input: the call transcript + extracted_data + the active rubric (key + guidance per flag). Output (structured JSON, function-calling — no free-text parsing): a list of `{flag_key, evidence_quote (verbatim), confidence 0–1}` for flags that apply. Instructed to only flag what the _transcript supports_ and to quote the exact line.
- **Pass 2 (`5.4`)** — for each proposed flag, independently: "Given this transcript, is `<flag>` actually true? The claimed evidence is `<quote>`. Answer true/false + the correct evidence + confidence." Runs per-flag (or batched per call) so the verifier judges each claim on its own.
- **Merge:** Pass 2 confirms → `confirmed`. Pass 2 refutes → dropped (not stored, or stored `rejected` for audit). Low agreement/confidence → `needs_review`. A call's `needs_review` = any surviving flag is `needs_review`.
- **Human feedback:** confirm/reject in the UI sets `status` and clears `needs_review`; this is the trust loop (and a future fine-tuning/eval signal).

## Discovery pass (hourly)

A cron job samples recent human-reached calls — weighted toward calls with **few or no confirmed flags** (the rubric's blind spots) — and asks `5.4`: "What recurring situation appears here that none of these existing flags `<active keys>` capture?" Proposals become `review_flag_defs` rows (`is_candidate=true, active=false`) with a suggested key/label/lens/severity + example call ids. An admin reviews candidates in the UI and **approves** (→ `active=true`, joins the rubric) or dismisses. Sampled, not exhaustive — cheap.

## Review UI (Reporting hub → new "Call Review" tab)

- **Bucket list**, grouped by severity (🔴 first, 🟢 last). Each row: label · lens chip · **total / unreviewed / needs-eyes** counts, for the selected date/campaign/agent window. A pinned **"⚠️ Needs your eyes"** bucket on top.
- **Click a bucket →** deep-link to the existing **Calls list filtered to that bucket** (e.g. `/calls?review_flag=<key>&…`), with the **evidence quote** surfaced on each row. The operator reviews **call-by-call** using the existing **call detail modal** (transcript, recording, extracted data), ticks **Reviewed** (writes `call_reviews.reviewed_by/at`), and moves to the next.
- **Confirm / reject** a flag from the call view (esp. in "Needs your eyes") — the trust loop.
- **Discovery review**: a small "Suggested new flags" panel to approve/dismiss candidate flags.
- **Quick actions (thin reuse, deferrable):** a `hot_lead_not_booked` call → **Send to closer**; a bug → **spawn a task**.

The `/calls` list + detail modal are extended with: a `review_flag` filter param, an evidence-quote column when filtered, and a Reviewed control. No new call viewer.

## Scale, cost, error handling

- ~4–5k human-reached conversations/day × 2 passes. Ballpark ~$40–200/day; tunable via the per-pass model config. A **kill-switch setting** (`app_settings`) pauses the worker if cost/behavior runs away.
- Worker: pg_cron → secured endpoint (existing `DIALER_TICK_SECRET`-style gate), claims a batch per tick via CAS, runs every ~1 min, processes in parallel within a tick. Idempotent — flags upsert by (call, flag); re-runs are safe.
- **Structured output** (function-calling/JSON-schema) so parsing never guesses. LLM/parse failure → limited retries → `status='error'` + a visible error count (never silently dropped).
- Missing/too-short transcript → auto `no_conversation`, skip passes.

## Testing

- **Golden set** — a handful of hand-labeled real calls with known flags; the analyzer runs against them and asserts the expected flags (accuracy guardrail + regression net for prompt changes). Mockable without live OpenAI.
- **Unit** — the rubric prompt builder (from active defs), the two-pass merge (confirmed vs needs_review vs rejected), and the bucket aggregation query.
- **Live-env Playwright** — seed a call with a known transcript → run the worker → assert flags stored + the bucket + the `/calls?review_flag=` filter shows it.
- Everyday gates: `npx tsc --noEmit`, `npx eslint`, `npm run build`.

## Phasing (each independently shippable)

1. **Engine** — the 4 tables, seeded rubric, post-call enqueue, the worker (Pass 1 + Pass 2), stored flags. Verifiable from the DB; delivers the core accuracy.
2. **Review UI** — the Call Review tab (buckets), the `/calls` bucket filter + evidence column + Reviewed control + confirm/reject. _(Phase 1 + 2 = MVP.)_
3. **Discovery pass** — hourly candidate proposals + approve UI.
4. _(optional)_ **Action hooks** — send-to-closer / spawn-task per call.

## Verification gates

`npx tsc --noEmit` (baseline: the 3 pre-existing twilio-\*.spec.ts errors), `npx eslint`, `npm run build`. Migrations are additive; apply with `supabase db push --linked` before the code deploy. NOTE: production deploys are currently blocked by a Vercel fair-use limit — this feature builds on branches and ships once that's cleared.
