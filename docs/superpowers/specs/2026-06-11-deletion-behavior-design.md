# Deletion behavior — design spec

**Date:** 2026-06-11
**Scope:** Two related, approved deletion behaviors plus a one-off cleanup, shipped together in one PR.

- **A. Reset the lead when its call(s) are deleted.**
- **B. Make lead deletion a permanent (hard) delete.**
- **C. One-off: permanently purge the 173 already-soft-deleted leads.**

Guiding principle: keep the existing `leads.deleted_at` column and all its `is("deleted_at", null)` filters in place (dormant) — no sweeping schema migration. Only the delete _actions_ change.

---

## Shared helpers (new)

`src/lib/calls/delete-calls-core.ts` (extracted so both the calls action and lead-delete reuse it):

- `removeCallRecordings(admin, callIds)` — fetch `recording_path` for the given calls, remove the object-path ones from the `call-recordings` bucket (best-effort). (Lifts the logic already in `deleteCalls`.)
- `hardDeleteCalls(admin, callIds)` — `removeCallRecordings` then `delete from calls where id in (...)`.

`src/lib/leads/recompute-call-state.ts` (new, Feature A):

- `recomputeLeadCallState(admin, leadId)` — recompute one lead's call-derived fields from its REMAINING calls (see rules below). Reuses `CONVERSATION_OUTCOMES` / `DM_REACHED_OUTCOMES` from `@/lib/calls/outcomes` and `syncLeadNextCallToEarliestCallback` from `@/lib/callbacks/sync-next-call`.

---

## Feature A — reset lead when call(s) deleted

**Trigger:** `deleteCalls(ids[])` in `src/lib/calls/actions.ts` (admin-only; used by Calls row action, bulk bar, call detail modal).

**New steps, after the admin check:**

1. Read the calls being deleted → collect distinct `lead_id`s (affected leads) + the deleted call ids.
2. **Delete callbacks originating from these calls** — `delete from callbacks where originating_call_id in (deletedIds)` (do this BEFORE deleting the calls, since the FK would null the link). Do NOT touch `dnc_entries` (keep do-not-call blocks).
3. Hard-delete the calls (`hardDeleteCalls` — recordings + rows). (Existing behavior, now via the shared helper.)
4. For each affected lead, `recomputeLeadCallState`.
5. Revalidate `/calls`, `/analytics`, `/costs`, `/today`, `/leads`.

**`recomputeLeadCallState(admin, leadId)` rules** — read the lead's remaining calls (`id, created_at, ended_at, outcome`):

- **No calls remain → fresh reset:** `status='ready_to_call'`, `last_call_at=null`, `next_call_at=null`, `retry_counter=0`, `retry_position=0`, `call_back_later_count=0`, `resting_until=null`, `call_attempts=0`, `conversations=0`, `decision_maker_reached=false`.
- **Calls remain → rewind to reflect them:**
  - `call_attempts` = remaining count
  - `conversations` = count(remaining `outcome ∈ CONVERSATION_OUTCOMES`)
  - `last_call_at` = max(remaining `ended_at ?? created_at`)
  - `decision_maker_reached` = any(remaining `outcome ∈ DM_REACHED_OUTCOMES`)
  - reset forward machinery: `retry_counter=0`, `retry_position=0`, `call_back_later_count=0`, `resting_until=null`, `next_call_at=null`
  - **status (don't un-win / don't un-block):**
    - any remaining `outcome ∈ {goal_met, transferred_to_human}` → `goal_met` (and `next_call_at=null`)
    - else if a remaining call `outcome ∈ {dnc, invalid_number, language_barrier}` OR the lead's phone is on `dnc_entries` → `dnc`
    - else → `ready_to_call`
- **Surviving callbacks:** after the update, if the lead still has a pending `callbacks` row (from a call that was NOT deleted), set `status='callback'` and re-point `next_call_at` via `syncLeadNextCallToEarliestCallback`.
- **Deliberate simplification:** the retry _ladder_ resets to position 0 rather than being replayed — the lead re-enters normal rotation and the schedule rebuilds. Intended, documented.

---

## Feature B — hard-delete leads

**Trigger:** `bulkDeleteLeads({ leadIds })` in `src/lib/leads/bulk-actions.ts` (today a soft delete; used by the Leads bulk bar / row actions).

**New behavior:**

1. **Permission:** keep today's model — a user may delete leads they own; admins may delete any. Resolve the user; if not admin, verify every selected lead is owned by them (else reject). The destructive cross-table work then runs under the **service role** (calls have no delete RLS).
2. For the selected leads, gather their calls and `hardDeleteCalls` them (recordings + rows) — required because `calls.lead_id` is `ON DELETE RESTRICT`.
3. **Best-effort Meta cleanup:** for any selected lead with `meta_synced_at` set, remove it from its owner's Meta Custom Audience before deleting (reuse `leadToHashedRow` + `removeUsers` + the owner's `user_integrations` Meta config). Skip silently if the owner has no Meta connected. (Most leads have no email and were never synced, so this is usually a no-op.)
4. **Hard-delete the lead rows** (`delete from leads where id in (...)`, chunked). Callbacks, `lead_custom_values`, and emails cascade automatically; Calendly scheduled-events and API/idempotency refs `SET NULL`.
5. Revalidate `/leads`, `/calls`, `/analytics`, `/costs`, `/today`.

**Left unchanged:** the `deleted_at` column + every `is("deleted_at", null)` filter (dormant — harmless for hard-deleted rows, and keeps import-revival working for any pre-existing soft-deleted rows). **Lead merge** (`lead-actions.ts`) keeps soft-deleting the merged-away source — that's a merge, not a user "delete", and out of scope.

**Note:** hard delete is permanent (no undo) and removes the lead's call history (recordings/transcripts), which rolls out of analytics/cost totals. This is the accepted trade-off.

---

## C — one-off purge of existing soft-deleted leads

Not deployed code — a one-off operation I run once after B ships (so it uses the same permanent-delete path): permanently remove the 173 leads where `deleted_at is not null` (172 solidcore + 1 other), via the same steps as Feature B (recordings → calls → Meta cleanup → lead rows). Verify count before and after.

---

## Verification

Automated E2E was retired for this project, so verify with: `tsc --noEmit` clean (minus the 3 known twilio test errors), `next build` ✓, `eslint` ✓ on touched files. Plus a live read-only probe before/after the one-off purge. Ship as one PR; deploy after review.
