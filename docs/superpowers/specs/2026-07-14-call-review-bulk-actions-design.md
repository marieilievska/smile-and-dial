# Call Review — bulk actions & unreviewed-first flow

**Date:** 2026-07-14
**Status:** approved (Marija)

## Problem

Reviewing flagged calls is one-at-a-time: to clear a bucket you open each call's
detail modal and click "Mark reviewed". The "No conversation" bucket alone holds
116 voicemail/no-answer calls, so clearing it is 116 open→click→close cycles.
There is no way to act on many calls at once, and no way to clear a bucket you
don't need to open.

## Goal

Let an admin clear the review queue in bulk, while keeping the ability to open
and listen to individual calls. Voicemails are kept (not auto-suppressed) — the
fix is bulk actions, not hiding calls.

## Design

Four pieces, all reversible. "Reviewed" only stamps `call_reviews.reviewed_by/at`
(drops the call from the unreviewed count) — it never deletes a call or recording.

1. **Bulk "Mark reviewed" / "Reopen" in the Calls list.** Reuse the existing
   multi-select + "select all N matching" sweep (today used for bulk delete).
   In review context (a `review_flag` filter is active) the bulk bar gains
   "Mark reviewed" and "Reopen".

2. **Per-row "Reviewed" toggle.** In review context each row shows a quick
   reviewed toggle so a single call can be cleared without opening it. Needs a
   per-call `reviewed` boolean on the row.

3. **Per-bucket "Mark all reviewed" on the Call Review tab.** Each bucket row
   with `unreviewed > 0` gets a button that marks every call in that bucket
   reviewed in one click — no need to open the list.

4. **Unreviewed-first.** When arriving from a bucket, the Calls list defaults to
   showing only unreviewed calls (`reviewed=no`), so the queue counts down to
   zero as you clear it. A toggle switches to "show all" (`reviewed=all`). The
   default only applies when a `review_flag` is present; the general Calls list
   is unaffected.

## Implementation

- `src/lib/review/actions.ts`
  - `markCallsReviewed({ callIds, reviewed })` — admin-only; chunked
    (`.in` batches of 500 to dodge URI-length/1000-row limits) update of
    `call_reviews.reviewed_by/at`. `revalidatePath("/calls")` + `/reporting`.
  - `markBucketReviewed({ flagKey, reviewed })` — resolve the bucket's call ids
    via `resolveReviewFlagCallIds`, then delegate to the chunked update.
  - keep single `markCallReviewed` (delegates to `markCallsReviewed`).
- `src/lib/review/calls-filter.ts` — `resolveReviewFlagCallIds(..., { unreviewedOnly })`:
  after resolving flag call ids, when `unreviewedOnly` drop ids whose
  `call_reviews.reviewed_at` is not null (paginated lookup).
- `src/lib/calls/fetch-all-ids.ts` — resolve `review_flag` (+ the `reviewed`
  mode) and pass `reviewCallIds` into `applyCallFilters`, so "select all N
  matching" scopes to the bucket. (Fixes a pre-existing gap: the sweep ignores
  `review_flag` today.)
- `src/app/(app)/calls/page.tsx` — parse `reviewed` (`no` default in review
  context, else `all`); pass `unreviewedOnly` to the resolver; add a per-call
  `reviewed` flag to `DisplayCall`; render the unreviewed/all toggle and pass
  review context to the bulk bar + rows.
- `src/app/(app)/calls/calls-bulk-bar.tsx` — Mark reviewed / Reopen in review
  context (props: `reviewFlag`, `isReviewContext`).
- `src/app/(app)/calls/columns.tsx` + row actions — per-row reviewed toggle in
  review context.
- `src/app/(app)/reporting/call-review-table.tsx` — per-bucket "Mark all
  reviewed" button (client action + `router.refresh`).

## Testing / verification

- Unit test the chunking helper (pure) under `tests/*.unit.test.ts` (Vitest).
- No CI gate (Playwright removed) — verify locally with `tsc --noEmit`,
  `next build`, `eslint`.
- Manual: click a bucket → list shows unreviewed only → select all → Mark
  reviewed → bucket unreviewed count drops to 0; Reopen restores.

## Out of scope (YAGNI)

Auto-suppressing "No conversation"; bulk confirm/reject of individual flags;
review actions on the general (non-bucket) Calls list.
