---
name: daily-outcome-audit
description: Use when auditing Smile & Dial call outcomes for accuracy — verifying yesterday's dispositions (goal_met, dnc, gatekeeper, voicemail, ai_error, hung_up, callback, not_interested…) are correct, finding mislabels, fixing the data, and hardening the live ElevenLabs agents so future calls classify right. Triggers: "audit outcomes", "were these really voicemails/dnc/goal_met", "the win count looks off", "check yesterday's calls".
---

# Daily Outcome Audit

## Overview
Each call gets one **outcome** (disposition) that drives real decisions: who to stop calling (`goal_met`, `dnc`, `not_interested`), the connect-rate metric, the decision-maker metric, and the callback queue. The AI over/under-claims, so outcomes drift from reality. This skill audits an outcome against ground truth, fixes **yesterday's** data, and tightens the live agents so it stops recurring.

**Hard rule (Marija):** audit and change **only yesterday's** calls (Eastern day). Never touch other days.

**Core principle:** every outcome has an *objective* ground-truth signal that beats the AI's guess (a booking row, a termination reason, a self-request in the transcript). Judge against the signal, not the label.

## When to use
- Daily accuracy pass on yesterday's outcomes, or a spot-check ("are these really voicemails?").
- The success/booking number looks wrong, DNC seems inflated, `ai_error` spiked.
- One outcome at a time — pick the outcome, pull the calls, read/verify, fix, harden.

## The daily loop
**Fast path (all at once):** `node scripts/audit-day.js [YYYY-MM-DD]` does steps 1–4 in one read-only pass — credit health, every outcome's counts, booking reconciliation, and transcript dumps for the judgment outcomes — and prints what needs your eyes. Then jump to step 5 (fix) and 6 (harden). Use the per-step flow below when you want to drill into one outcome.

1. **Credit check first** — `node scripts/credit-check.js`. `ai_error` = ElevenLabs ran out of credits; a spike means calls are failing *right now*. Fix billing before anything else. (Only Marija can top up.)
1b. **Null-outcome sweep** — a **completed** call must NEVER have `outcome=null` (only in-flight `dialing`/`queued` may). Check `calls?outcome=is.null&status=eq.completed` (count via `Prefer: count=exact`, `Range: 0-0`). Since the Aug-2026 fix `classifyCallOutcome` always buckets, so a non-zero count means either pre-fix strandings or a call the fixed webhook hasn't reprocessed. Remedy = re-fetch each conversation from the **EL API** (`/v1/convai/conversations/{id}`, retry on 429/5xx — a silent fallback to the stored transcript loses `termination_reason` and misreads a quota-kill as a hang-up), re-run `classifyCallOutcome`, then: **delete** no-conversation quota-kills (`termination_reason` "exceeds your quota limit" + no real 2-way exchange, per the ai_error rule), give everything else its accurate outcome, and **recompute** each touched lead's `call_attempts`/`conversations` (webhook logic: `call_attempts`=all its calls; `conversations`=calls whose outcome ∈ `CONVERSATION_OUTCOMES`).
2. **Pull the outcome** — `node scripts/audit-outcome.js <outcome>` (defaults to yesterday ET). Dumps counts, per-campaign split, booking/tool signals, and readable transcripts.
3. **Verify against the signal** — read `outcome-playbook.md` for what "correct" means for THAT outcome, the objective signal, and the known traps. Read transcripts for the judgment calls.
4. **Reconcile goal_met** — `node scripts/reconcile-bookings.js` cross-checks real Calendly bookings ↔ `goal_met` in BOTH directions (false wins *and* real bookings hiding under the wrong label).
5. **Fix the data (dry-run first)** — relabel mislabeled calls + set each lead's state to match. See `fix-patterns.md`. Bulk writes ALWAYS dry-run, then `--apply`.
6. **Harden the future** — if the AI is systematically wrong, PATCH the live agents' disposition prompt (and/or conversation prompt). See `fix-patterns.md` → "Live-agent PATCH".
7. **Record it** — update the memory file `reference_outcome_classification` with findings + fixes.

## Quick reference — outcome ground-truth signals

| Outcome | Ground-truth signal (not the label) | Top trap |
|---|---|---|
| `goal_met` | real Calendly booking (`leads.calendly_event_uri` + `book_appointment` tool) | gatekeeper email marked as a win; real bookings mislabeled `gatekeeper`; phantom bookings (tool fired w/o a yes) |
| `dnc` | the **person themself** asked to stop, unprompted | agent *offered* removal → "sure" got marked dnc |
| `ai_error` | EL `termination_reason` = "exceeds your quota limit" | invisible in transcript; a spike = billing outage |
| `voicemail` | machine greeting / EL voicemail_detection, no human | AI-receptionist self-ID; late VM after a real human = gatekeeper |
| `gatekeeper`/`_not_interested`/`not_interested` | who declined (owner vs staff) + how firmly | `not_interested` auto-stamps decision-maker-reached |
| `callback` | a real time/window was given | "they'll call us" / no time |
| `hung_up_immediately`/`_later`/`no_answer` | fuzzy short-call trio — behaviour-neutral (all retry) | **don't** bulk-relabel; churns labels for nothing |
| `(null)` on a **completed** call | should NEVER exist — the webhook always buckets now | pre-fix strandings / an EL quota-kill whose reason lands *after* the webhook → re-fetch EL + reclassify (see step 1b); delete no-conversation quota-kills |

Full recipes: **`outcome-playbook.md`**. Fix mechanics + safety: **`fix-patterns.md`**.

## Environment
- Prod Supabase (ref `gpgmtmmmxasbadwjpdxf`) is reached via **PostgREST + `SUPABASE_SERVICE_ROLE_KEY`** from `.env.local` — the Supabase MCP can't reach it. PostgREST hard-caps every response at **1000 rows** — paginate (the scripts do).
- Live agents via `ELEVENLABS_API_KEY`. Two active webinar agents: **Reason First** `agent_1501kzdv8mmfehtbm787p7q1dq51`, **Pattern Interrupt** `agent_4401kzc79z8dfzq8n4rf75krhkcr`.
- All scripts default to **yesterday, America/New_York**. Pass `YYYY-MM-DD` to override (still one ET day).

## Safety — read before any write
- **🚫 NEVER change a live agent's prompt without Marija's explicit confirmation** (disposition prompt OR conversation prompt). This is a hard rule. Data relabels are fine to apply after a dry-run, but any agent-behaviour change: show Marija the exact before/after diff, explain the effect, and wait for a clear "yes" before running `el-patch.js`. The script enforces it — `--apply` refuses unless `--confirmed` is also passed (only pass `--confirmed` after she says yes).
- **Yesterday only.** Every fix filters to the ET day window; confirm the row count matches before applying.
- **Dry-run every bulk write**, eyeball the plan, then `--apply`.
- **Before un-DNC-ing a lead**, confirm it has NO other DNC signal (a `dnc` call on another day OR a `dnc_entries` row by phone/`source_call_id`). Un-DNC-ing someone who really asked to stop = calling someone who told us not to.
- **Never create/cancel real Calendly registrations to "test".** Cancelling a shared webinar (group) event drops *every* registrant. Booking is additive/OK; cancelling is off-limits.
- **git:** branch off `origin/main`; stage files **explicitly** (`git add <file>`, never `-A` — a parallel session's files get swept in); commit `--no-verify` (a lint-staged hook races concurrent git). Run `tsc`/`eslint`/`build` manually (no CI gate).

## Common mistakes
- Judging a system-signal outcome (`ai_error`) or the fuzzy short-call trio by reading transcripts → wasted relabels. Use the signal; leave the fuzzy trio alone.
- Treating `goal_met` as universal — the bar is **per campaign**. For the webinar campaigns it's a booking; a research campaign's bar is different. Don't impose "booking required" globally.
- Relabeling a call but forgetting to move the **lead's** status/next_call_at — a `goal_met` lead stays terminal (never called again); a relabeled lead stays wrongly rested. Always fix both.
- Editing the code prompt (`agents.ts`) but not the **live** EL agents (or vice-versa) — they drift. Do both.
