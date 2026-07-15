# Call Reviewer — clearer curation UX — design

- **Date:** 2026-07-15
- **Status:** Approved for planning
- **Approach:** B — make the review actions clear AND complete the curation toolkit (no full rebuild)

## Problem

The Call Reviewer has three curation actions at three different levels, badly
signposted and using colliding words, so Marija "can't use it to the best of its
ability":

1. **Confirm / Reject** a flag (`setFlagStatus`, in `CallReviewPanel`,
   `src/app/(app)/calls/call-detail-modal.tsx` ~314/322) — adjudicates ONE AI flag
   on ONE call. Reject drops it from its bucket. Unlabeled intent ("I don't know
   what it serves").
2. **Mark reviewed** (`markCallReviewed`, same panel ~270) — call-level "handled."
3. **Approve / Dismiss** a suggested flag (`approveCandidate`/`dismissCandidate`,
   `suggested-flags-panel.tsx`) — edits the AI's RULEBOOK, not any call.

And two curation levers are simply **missing**: there's no way to (a) tune the
flags **already running** (only approve/dismiss the AI's _new_ suggestions), or
(b) see a flag's **track record** (how often it's confirmed vs. a false alarm),
which is what tells you which flags to fix or retire.

## Goal

Split "reviewing calls" from "tuning the AI," plain-language every action, and add
active-flag management (retire/reactivate/edit) + a per-flag track record — so
Marija can genuinely sharpen the reviewer over time. **No schema change**
(`review_flag_defs` already has `active`/`label`/`guidance`/`severity`;
`call_review_flags.status` is confirmed/needs_review/rejected).

## Design

### 1. Two clearly separated jobs on the Call Review tab

Restructure the tab (`call-review-table.tsx` + `reporting-tabs.tsx`) into two
labeled sections:

- **"Review flagged calls"** — the existing buckets (`fetchReviewBuckets`): drill
  in → listen → adjudicate → mark handled. Unchanged mechanics.
- **"The AI's checklist"** — new section (below) for managing what the AI watches.

### 2. Plain-language the per-call actions (`CallReviewPanel`)

- Per-flag control: replace bare **Confirm / Reject** with **"Did the AI get this
  right?" → Looks right / False alarm**, plus one line: _"False alarm removes it
  from this bucket and counts against this flag's accuracy."_ (Same
  `setFlagStatus` calls — `confirmed`/`rejected` — just relabeled + explained.)
- **Mark reviewed / Reviewed ✓ — reopen** stays, visually separated and clearly
  call-level ("I've handled this call"). Same `markCallReviewed`.

### 3. "The AI's checklist" — the new curation workspace

A new admin panel (new component `ai-checklist-panel.tsx`, rendered in the Call
Review tab, fed by `reporting/page.tsx`). Two parts:

**a) Active flags (the running checklist).** Lists every `active` `review_flag_def`
with:

- **What it checks** — the `guidance`, in plain words, + lens/severity.
- **Track record** — confirmed vs. rejected (false-alarm) counts from
  `call_review_flags` for that `flag_key`, so noisy flags stand out.
- Per-flag actions: **Turn off** (retire → `active=false`; it stops being checked
  and its bucket disappears) / **Turn on** (reactivate); **Edit** (label / guidance
  / severity) to tighten a flag that over-fires.

**b) Suggestions (unchanged behavior, moved + recopied).** The existing
`SuggestedFlagsPanel` (discovery candidates → Approve/Dismiss) lives here too,
under the same "checklist" heading, since it's the same job — deciding what the AI
watches. Clarify its copy.

### 4. Under the hood

- **New actions** in `src/lib/review/actions.ts` (admin-gated, service-role, mirror
  `approveCandidate`):
  - `setFlagActive({ key, active })` — retire/reactivate an active flag
    (`.eq("is_candidate", false)` so it can't touch a candidate).
  - `updateFlagDef({ key, label?, guidance?, severity? })` — edit an active flag.
- **New fetch** in `src/lib/review/buckets.ts`: `fetchChecklistFlags(client)` →
  active flags joined to per-flag confirmed/rejected counts (query
  `call_review_flags` grouped by `flag_key` + `status`; shape in a pure, unit-tested
  helper). Retired flags optionally shown collapsed so they're reactivatable.
- Everything else reuses existing pieces (buckets, candidates, confirm/reject,
  mark-reviewed).

### 5. Rollout — re-run all calls with the playbook

Re-queue **all** done reviews (including the 20 already human-reviewed) so the
whole board is judged consistently with the agent playbook. This **resets the
`reviewed_at` state** on the re-run calls (they're being re-judged) — intended,
and called out to Marija. One-time, guarded, service-role; the cron re-analyzes.

## Out of scope (YAGNI)

- Full "train your reviewer" rebuild (Option C).
- Per-call action hooks (send-to-closer / spawn-task) — previously declined.
- Editing a candidate before approving, or bulk flag edits — not now.
- Auto-retiring flags by false-alarm rate — surface the rate; let the human decide.

## Testing

- **Unit (vitest):** the pure shaping helper for `fetchChecklistFlags` (active
  defs + count rows → checklist rows with confirmed/rejected tallies; retired flags
  handled). `orderBuckets` stays green.
- **Prod/manual:** admin-gated UI — verify on the Reporting → Call Review tab that
  the two sections render, retire hides a flag's bucket, reactivate restores it, an
  edit changes the guidance the next analysis uses, and the track record reflects
  confirm/reject actions.

## Rollout / sequencing

Single PR: `actions.ts` (2 new actions) + `buckets.ts` (checklist fetch + pure
helper) + the UI (reframed `CallReviewPanel`, new `ai-checklist-panel.tsx`, tab
split, moved suggestions) + `reporting/page.tsx` wiring. **No migration.** The
all-calls re-run runs after deploy.
