# Daily Outcome Audit — Accuracy Improvements

**Date:** 2026-08-18
**Status:** Design approved (Marija), pending spec review → implementation plan
**Owner:** Marija (PM) · built by Claude
**Skill:** `.claude/skills/daily-outcome-audit/`

## Problem

The daily-outcome-audit skill corrects yesterday's call dispositions and hardens the live agents. Today its model is "dump every judgment transcript and read them." At **3,000+ calls/day** that doesn't scale, and it visibly failed: a grounding pass over the last 7 days showed **08-12 (3,328 calls) was barely audited** — almost every label was still raw AI.

Reading raw 08-12 surfaced a systematic, objective-signal-backed mislabel the exhaustive-read approach missed:

- `decision_maker_reached` is a value the AI **already records** on every connected call, as a string enum `"yes" / "no" / "unknown"`.
- **20 of 55 `not_interested` calls (36%) on 08-12 carry the AI's own `decision_maker_reached="no"`** — the AI labeled "the *owner* declined" while itself reporting it never reached the owner. On 08-11 that count was **0** (a same-day behavioral swing nothing flagged).
- Each wrong one **rests the lead 30 days instead of 15** and **inflates the decision-maker metric** (`not_interested` unconditionally implies DM-reached in code via `OUTCOME_IMPLIES_DM`).
- Reading the flagged calls confirmed they are role-unstated soft brush-offs ("I think we're okay, thank you", 9–22s), not confident owner declines — which the playbook's own bias rule already says belong in `gatekeeper_not_interested`.

Two adjacent findings from the same pass:
- **Drift is invisible.** `not_interested dm=no` swung 0→20 and `ai_receptionist` swung 7→55 between two days; the skill audits one day in isolation with no baseline.
- **Extractor name bug** (logged, out of scope): `owner_name`/`employee_name` sometimes capture the agent's own persona name ("Tom" — the agent opens with "Hello, Tom speaking"). Pollutes summaries/handoff, not outcomes.

## Goals

1. Make a 3,000-call day **auditable** by targeting review at objective contradiction-flags instead of reading everything.
2. **Fix the `not_interested` over-claim at the source** so it stops recurring and stops inflating the DM metric.
3. **See drift and accuracy trend over time**, so a behavioral shift pings the day it happens and source-fixes are visibly working.

## Non-goals

- No change to the "fuzzy short-call trio" handling (`hung_up_*`/`no_answer`) — behaviour-neutral, bulk-relabel churns labels for nothing (unchanged).
- No live-agent **prompt** change this round (Marija chose the code guard only). Prompt tightening is noted as a future option, still gated behind `el-patch.js --confirmed`.
- The extractor name-confusion bug is logged for a separate pass.
- Voicemail's ~99.7%-correct status and the IVR/hold-queue-as-voicemail decision stand (Marija's call).

## Ground truth this builds on

- Outcome logic: `src/lib/calls/classify-outcome.ts` · outcome sets: `src/lib/calls/outcomes.ts` · DM logic: `src/lib/calls/decision-maker.ts` · lead-state effects: `src/lib/dialer/retry-engine.ts`.
- `decision_maker_reached` is a **string enum** `"yes"/"no"/"unknown"`/absent in `calls.extracted_data`. (The skill's dumps print `dm=…` but never told the reviewer it is load-bearing or an enum — easy to misread as a boolean. Fixed in the playbook.)
- The webhook already computes `extractedDataOf(payload.analysis)` and calls `classifyCallOutcome` (`post-call-webhook.ts:853`), so the `dm` value is available at classify time — a clean thread-through.
- `decision-maker.ts` already vetoes a stray `dm="yes"` on excluded outcomes (`OUTCOME_EXCLUDES_DM`). The new guard is the **symmetric** move on the other side.

---

## Layer 1 — Signal triage + scorecard (the new front door)

**New: `scripts/triage.js`** — read-only, one Eastern day (default yesterday). Supersedes `audit-day.js`'s exhaustive dump. `audit-outcome.js` stays for drilling into a single outcome.

It produces three artifacts:
1. **Scorecard** — per-outcome table: count, manual/AI split, #flagged, flag reason.
2. **"READ THESE" list** — flagged call IDs grouped by flag, one-line reason each, written to a `_out-triage-<date>.txt` file (same convention as today's dumps, gitignored).
3. **Suggested relabel map** — a draft `map` JSON for the high-confidence structured flags (e.g. `not_interested`+`dm≠yes` → `gatekeeper_not_interested`). **Never auto-applied.** A human dry-runs `relabel.js`, eyeballs, then `--apply`.

### Objective flags (each is a contradiction between the label and a signal the AI already recorded)

| Outcome | Flag when… | Interpretation |
|---|---|---|
| `not_interested` | `dm ≠ "yes"` (`no`/`unknown`/absent) | owner-decline label without a reached owner → `gatekeeper_not_interested` |
| `gatekeeper_not_interested` | `dm = "yes"` | reached owner but labeled a gatekeeper decline (read) |
| `goal_met` | lead has **no** `calendly_event_uri` (either direction: booked-not-goal_met too) | false win / hidden win — folds in `reconcile-bookings.js` |
| `callback` | no `extracted_data.callback_datetime` **and** no `callbacks` row with `scheduled_at` | stranded (dialer has no time to dial) |
| `dnc` | an **agent** turn matches an offer-to-remove phrase | agent-manufactured DNC, not a real self-request |
| `voicemail` | *(sampled, N≈60)* `genuineHumanReplyCount ≥ 2` | a human answered, then a mailbox → `gatekeeper` |
| any | `outcome` null on a `status='completed'` call | stranded (should be zero post-#394) |
| `ai_error` | count + first/last time window | incident signal → `credit-check.js` (not a relabel target) |

`goal_met`×`dm≠yes` is **not** flagged: a booking made by a non-owner (front desk books a slot) is a valid `goal_met` by design (`decision-maker.ts` deliberately excludes `goal_met` from `OUTCOME_IMPLIES_DM`).

### Design choices (explicit)

- **Voicemail is sampled, not read whole.** ~1,600/day makes read-all the reason the habit breaks. Triage pulls transcripts for a bounded sample and flags human-reply ones. It **prints how many it sampled and skipped** — never a silent "clean."
- **Always-read buckets stay small and whole:** all `dnc` (~15) and all `goal_met` (~30) are read regardless of flags — low volume, high stakes.
- **Two-phase data pull for efficiency:** a light `select` (no `transcript_json`) over the whole day for counts + structured flags; a second targeted `transcript_json` pull only for `dnc`, the voicemail sample, and flagged rows. Keeps a 3k-day pull lean.

### New: `scripts/_signals.js`

Small JS helpers mirroring `classify-outcome.ts`: `genuineHumanReplyCount`, the machine-greeting/reply regexes, and a new `agentOfferedRemoval` regex (`/take you off|remove you (from|off)|off (the|our|your) (list|calling)|add you to (the |our )?do not call|stop calling you/i` on **agent** turns). Marked in-file as a **review aid** — every actual write still goes through human-confirmed `relabel.js`, so an approximation here is safe. The authoritative copy stays the TypeScript one (Layer 2 puts it under unit test).

---

## Layer 2 — Fix at the source (code guard)

### The guard

In `classify-outcome.ts`, after the outcome is decided, add a deterministic downgrade:

> A call stays `not_interested` **only if** `decision_maker_reached === "yes"`. Otherwise (`"no"`, `"unknown"`, or absent) it becomes `gatekeeper_not_interested`.

Rationale in-code: `not_interested` rests 30d + implies DM-reached; if the extractor itself didn't establish the owner, the decliner isn't confirmed to be the owner. This mirrors `OUTCOME_EXCLUDES_DM`'s veto of a stray `dm="yes"`, and matches the audit playbook's bias rule.

### Implementation

- Add `decisionMakerReached?: string` to `classifyCallOutcome`'s input; pass it from `post-call-webhook.ts` (`extractedDataOf(payload.analysis)?.decision_maker_reached`).
- Keep the function pure (no I/O); the guard is a final adjustment before the `reachedHuman` computation. `gatekeeper_not_interested` is not in `NO_HUMAN_OUTCOMES` and isn't a hang-up, so `reachedHuman` stays `true` (a gatekeeper did answer) — consistent.
- **Unit tests** (`tests/classify-outcome.unit.test.ts`, or extend the existing suite): `not_interested`+`dm="yes"` stays; +`"no"`/`"unknown"`/absent → `gatekeeper_not_interested`; existing branches (machine, quota, silence, hang-up split) unchanged. Audit any existing test that asserts `disposition=not_interested → not_interested` regardless of `dm` and update it.

### Consequence (accepted by Marija)

- Decision-maker count **drops** to a true number (stops counting `dm≠yes` calls). `OUTCOME_IMPLIES_DM = {not_interested}` stays correct because post-guard, any remaining `not_interested` is `dm="yes"`.
- Those leads rest **15d not 30d** (re-called sooner).

### Historical data + the "yesterday only" rule

The skill's hard rule ("touch only yesterday") governs the **daily** audit. This is a **one-time historical correction** of the two real operating days we grounded on (08-11: 0 affected; 08-12: ~20). Bounded and explicit:
- Deploy the guard first (future calls classify right), then relabel history — no dependency between them, but deploy-before-data-fix is the house habit.
- Relabel via `relabel.js` (dry-run → eyeball → `--apply`); it refuses any call whose current outcome isn't the expected `not_interested`, and moves each lead to the `gatekeeper_not_interested` state (15d rest, counters 0). Gated on Marija's nod.
- Update `scripts/backfill-dm-not-interested.mjs`'s header/logic so it no longer asserts the retired "not_interested is always DM" philosophy (it still functions: post-guard `not_interested` is `dm="yes"`, so its false→true flip stays valid).

---

## Layer 3 — Drift watch + scorecard history

- **`scripts/scorecard.jsonl`** (committed): triage appends one line per audited day — `{date, total, byOutcome:{...counts}, manualByOutcome:{...}, ratios:{not_interested_dm_no, ai_receptionist_share, callback_share, connect_rate, goal_met, dnc}}`. `connect_rate` **reuses the canonical `CONNECTED_OUTCOMES` / `NON_CALL_OUTCOMES` sets from `outcomes.ts`** — never a locally re-defined set (divergent sets caused the prior connect-rate bug).
- **Drift compare** (in `triage.js`): compare the day's ratios to the trailing median of the last N (≈5) audited days in the ledger. Print `DRIFT: <metric> <today> vs <baseline> — check for an agent/campaign change` when a metric deviates beyond a threshold (relative % or absolute floor, per metric). With <2 prior days it prints "baseline building."
- Would have caught both the `not_interested dm=no` 0→20 and `ai_receptionist` 7→55 swings the day they happened.

---

## Integration — SKILL.md daily loop (rewritten)

1. `node scripts/credit-check.js` — credit health / `ai_error` incident (unchanged).
2. `node scripts/triage.js [date]` — scorecard + **drift** + null-sweep + "READ THESE ~40" + suggested relabel map.
3. Read the flagged list + all `dnc` + all `goal_met`; judge against `outcome-playbook.md`.
4. `node scripts/reconcile-bookings.js` — booking cross-check (also folded into triage; kept for a focused view).
5. Dry-run `relabel.js` on the (reviewed) map → `--apply`.
6. *(optional, gated)* `el-patch.js --apply --confirmed` — only with Marija's explicit yes.
7. Scorecard auto-logged; update memory `reference_outcome_classification`.

**Docs touched:** `SKILL.md` (loop + quick-ref front door), `outcome-playbook.md` (add the objective cross-field signals per outcome; state `dm` is the `yes/no/unknown` enum; note the `not_interested` rule is now enforced in code), `fix-patterns.md` (triage-seeded relabel map; the guard).

## Files

**New:** `scripts/triage.js`, `scripts/_signals.js`, `scripts/scorecard.jsonl`
**Modified (skill):** `SKILL.md`, `outcome-playbook.md`, `fix-patterns.md`; **remove** `audit-day.js` (superseded)
**Modified (app):** `src/lib/calls/classify-outcome.ts`, `src/lib/elevenlabs/post-call-webhook.ts`, `tests/classify-outcome.unit.test.ts` (new or extend), `scripts/backfill-dm-not-interested.mjs` (comment/logic)

## Phasing

- **Phase 1 — Triage + scorecard write.** `triage.js`, `_signals.js`, scorecard append, skill-doc updates, remove `audit-day.js`. Skill-only (no app deploy). *Verify:* run on 08-12; it must flag the 20 `not_interested`, the hidden-win `goal_met`, and any `dnc` offers, and print the scorecard.
- **Phase 2 — Source guard.** `classify-outcome.ts` guard + webhook thread + unit tests + backfill-script comment. App code → PR → `tsc`/`eslint`/`next build` → merge → Vercel deploy. Then the gated one-time 08-11/08-12 relabel (dry-run → apply).
- **Phase 3 — Drift compare.** Add baseline-compare to `triage.js` (Phase 1 already writes history, so this reads it). Small.

## Safety (all existing rules preserved)

- Every bulk write dry-runs first; `relabel.js` refuses unexpected current-outcomes and blocks un-DNC unless DNC-clean.
- No live-agent prompt change this round; if ever done, `el-patch.js` still requires `--confirmed` after Marija's explicit yes.
- git: branch off `origin/main`, stage files explicitly (never `-A`), commit `--no-verify`, run `tsc`/`eslint`/`build` manually (no CI). App code (Phase 2) consults `node_modules/next/dist/docs/` per AGENTS.md before edits to the webhook route.
- No backups on the routine relabel; verify the filter hits only the intended rows (Marija's standing preference).

## Open questions for spec review

- Voicemail sample size (default 60/day) and the per-metric drift thresholds — start with these defaults, tune after a few live runs.
- Keep `reconcile-bookings.js` as a standalone too, or fully fold into `triage.js`? (Proposed: keep both.)
