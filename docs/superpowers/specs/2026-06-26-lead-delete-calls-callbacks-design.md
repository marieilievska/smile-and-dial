# Delete calls & callbacks from the lead detail page

**Date:** 2026-06-26
**Status:** Design approved, pending spec review

## Problem

On the lead detail page (`/leads/[id]`) there's no way to delete a call or a
callback. Calls appear in the activity feed (open a detail popup) but can only be
deleted from the admin `/calls` list; callbacks aren't shown on the lead page at
all. We want admins to delete both from the lead page.

## Decisions (approved)

1. **Admin-only.** Delete affordances render only for admins; the underlying
   server actions already enforce an admin check (they use the service-role
   client, so the in-code admin gate is the real protection).
2. **Call delete lives in the call detail popup** (`CallDetailModal`), with a
   confirm. Reuses the existing `deleteCalls([id])`.
3. **Callbacks get a new "Callbacks" section** on the lead page (they aren't shown
   today), listing the lead's callbacks with an admin Delete per row. Reuses the
   existing `deleteCallbacks([id])`.
4. **Permanent (hard) delete** for both, via the existing actions (which recompute
   the lead's counters / re-sync next-call timing). Confirm dialog on each.
5. **No DB migration.**

## Reuse (existing, tested)

- `deleteCalls(ids: string[])` — `src/lib/calls/actions.ts`. Admin-checked,
  service-role; deletes related callbacks, hard-deletes the calls + recordings,
  then `recomputeLeadCallState()` per affected lead.
- `deleteCallbacks(ids: string[])` — `src/lib/callbacks/actions.ts`. Admin-checked,
  service-role; hard-deletes, then `resyncLeadAfterCallbackRemoval()` per lead.

Both are confirmed exported server actions. The plan will confirm their exact
return shape and that they `revalidatePath` (and add a lead-path revalidate if
missing); the client will also `router.refresh()` after a successful delete.

## Non-goals

- Bulk delete from the lead page (the `/calls` and `/callbacks` lists already do
  multi-select).
- Soft-cancel of callbacks from the lead page (the user chose hard delete; the
  `/callbacks` list already has cancel).
- Letting non-admins delete.
- Editing calls/callbacks.

## Components & changes

### Determine + thread `isAdmin`

- `src/app/(app)/leads/[id]/page.tsx` (server): read the viewer's `profiles.role`
  (or reuse however the page already knows the user) → `isAdmin`. Pass it to the
  client wrapper that mounts the call modal, and to the new callbacks section.

### Call delete — `src/app/(app)/calls/call-detail-modal.tsx`

- Add an `isAdmin?: boolean` prop (threaded from the lead page via
  `lead-page-client.tsx`). When `isAdmin`, render a destructive **Delete call**
  button (with `window.confirm`). On click: `await deleteCalls([call.id])`; on
  success, close the modal (clear the `?call=` param) and `router.refresh()`.
  On error, toast.
- `src/app/(app)/leads/[id]/lead-page-client.tsx`: accept + forward `isAdmin` to
  `CallDetailModal`.

### Callbacks section — new `src/app/(app)/leads/[id]/lead-callbacks.tsx` (client)

- Props: `{ callbacks: LeadCallbackRow[]; isAdmin: boolean }` where
  `LeadCallbackRow = { id, scheduledAt, status }`.
- Renders a compact list (scheduled date + status badge). For each row, when
  `isAdmin`, a Delete button (confirm) → `await deleteCallbacks([id])` → on
  success `router.refresh()`; on error toast. Optimistic hide of the removed row.
- `page.tsx` fetches the lead's callbacks
  (`from("callbacks").select("id, scheduled_at, status").eq("lead_id", id).order("scheduled_at", { ascending: false })`)
  and renders `<LeadCallbacks callbacks=… isAdmin=… />` in the page layout (near
  the activity feed). When there are no callbacks, show nothing or a muted "No
  callbacks."

### Server actions

- Reuse `deleteCalls` / `deleteCallbacks` as-is. If either does not already
  `revalidatePath` the lead route, add `revalidatePath("/leads/[id]", "page")` (or
  rely on the client `router.refresh()` — confirmed sufficient since the page is a
  Server Component re-rendered on refresh). No new actions unless a thin
  lead-scoped wrapper is cleaner; prefer direct reuse.

## Error / edge handling

- Deleting the call that's currently open in the modal → close the modal after
  success (the `?call=` id no longer resolves).
- Non-admin viewer → no delete buttons rendered; even if the action were called,
  the server admin check rejects it.
- Empty callbacks list → section renders "No callbacks" (or is omitted).
- A delete that fails (e.g. permission) → toast the error; row/modal stays.

## Testing (Playwright, live env only)

Extend or add a spec (e.g. `tests/lead-detail.spec.ts` if it exists, else
`tests/lead-delete.spec.ts`): seed a lead with a call + a callback. As an admin:
open the call popup → Delete → the call leaves the feed and `leads.call_attempts`
drops; delete the callback → it leaves the Callbacks list. Assert a non-admin
context sees no Delete buttons (or that the action errors for non-admin).

## Verification gates (run locally)

`npx tsc --noEmit`, `npx eslint`, `npm run build` — clean (only the 3 pre-existing
`twilio-*.spec.ts` errors). No migration.
