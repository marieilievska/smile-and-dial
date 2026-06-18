# Call status & outcome colors

**Date:** 2026-06-18
**Status:** Design — awaiting review
**Author:** Marija + Claude

## The problem (from the audit)

The Calls list shows an **outcome** pill; the Call detail page shows both an
**outcome** pill and a **status** pill. Two issues:

1. **"Failed" looks inconsistent.** `calls.status` and `calls.outcome` both have a
   `failed` value. The status map colors `failed` **red**; the outcome map colors
   `failed` **grey** — so on the detail page you can see a grey "Failed" (outcome)
   next to a red "Failed" (status). Same word, two colors.
2. **Most outcomes are grey.** The outcome→color map
   ([outcome-style.ts](../../../src/lib/outcome-style.ts)) only colors 3 outcomes
   green and 3 red; the other ~10 (voicemail, no answer, busy, **failed**,
   gatekeeper, hung up, …) fall through to one grey, so the page reads as a grey
   blob and `failed` is grey by accident.

## Decision (approved direction)

A small, **4-tier semantic palette** — color encodes a category, the label
carries the detail (not a unique color per value). Plus a fix so a finished call
shows only one pill.

### Outcome → tier

| Tier                       | Badge variant (existing) | Outcomes                                                                                                        |
| -------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| **Win**                    | `success` (green)        | goal_met, callback, transferred_to_human                                                                        |
| **Didn't connect — retry** | `warning` (amber)        | voicemail, no_answer, busy, hung_up_immediately, gatekeeper, call_back_later, language_barrier, ai_receptionist |
| **Failed / hard no**       | `destructive` (red)      | failed, invalid_number, not_interested, dnc, ai_error                                                           |
| **Neutral**                | `secondary` (grey)       | anything else / unknown only                                                                                    |

### Status → tier (unchanged, already correct)

- **Live** → the accent variant (`coral`): queued, dialing, ringing, in_progress
- **Failed/cancelled** → `destructive` (red)
- **completed** → `secondary` (grey), and hidden on the detail page (see below)

No new Badge variants are needed — `success` / `warning` / `destructive` /
`coral` / `secondary` all already exist
([badge.tsx](../../../src/components/ui/badge.tsx)).

### The two-pill fix

On the call detail page, show the **status** pill only while the call is **live**
(queued/dialing/ringing/in_progress), or as a fallback when there's no outcome to
show. Once a call is terminal _and_ has an outcome, show only the **outcome** pill.
Result: a failed call shows a single red "Failed" — never a grey + red pair.

Concretely, the detail modal's `showStatus` becomes roughly:
`isLive(status) || (!outcome && status !== "completed")`.

## Scope

- Edit `src/lib/outcome-style.ts`: rework `outcomeBadgeVariant` into the 3 colored
  tiers above (+ grey default). **Do not disturb** any non-color use of the
  existing outcome sets — if `POSITIVE_OUTCOMES` / `NEGATIVE_OUTCOMES` are imported
  elsewhere (e.g. analytics), leave them as-is and categorize colors separately.
- Edit `src/app/(app)/calls/call-detail-modal.tsx`: the `showStatus` rule.
- Update the stale doc comment in `outcome-style.ts` that says failed is neutral.

This also fixes the Calls **list** automatically (it renders the outcome pill via
the same map).

## Out of scope

- New badge colors / per-value unique hues (deliberately rejected — that's the
  noisy "2016" look).
- Re-coloring lead status, campaign status, or callback status (those already have
  sensible palettes; not part of this request).
- Any data/enum changes — colors only.

## Safety & rollout

- **Pure front-end, presentation only.** No data, query, enum, or server change.
- **Local verification:** `npx tsc --noEmit`, `npx eslint` on changed files,
  `npm run build` clean.
- **Contract test:** colors are visual; if an existing calls spec asserts a
  variant/selector that changes, update it — otherwise no new spec needed.
- **Deploy:** branch `feat/calls-status-colors` → PR → merge to main (auto-deploys).
