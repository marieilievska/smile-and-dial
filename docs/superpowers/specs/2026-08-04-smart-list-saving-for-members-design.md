# Opening smart-list _saving_ to members — design

**Date:** 2026-08-04
**Status:** Spec for review (not yet built)
**Owner:** Marija
**⚠️ Security-sensitive — do not build without reviewing the `refresh_smart_list` change below.**

## Goal

Members (builders) can already **use** the advanced Filter Builder on /leads (opened in #340 — `leads_matching_filter()` is `security invoker`, so a member's recipe only matches their own leads). But **saving** a filter as a reusable smart list is still admin-only, so members persist targeting via saved views instead. Open smart-list create/edit/delete to members, scoped to their own leads and their own lists.

## The security crux (must solve)

`refresh_smart_list(in_id)` (migration `20260621120000_smart_list_members.sql`) is **SECURITY DEFINER** — the comment says it "runs as owner, can read all leads and write members." It computes a list's membership by evaluating the recipe via `leads_matching_filter()` and full-replacing `smart_list_members`.

Because it runs as the definer (table owner, which **bypasses RLS**), the inner `leads_matching_filter()` also runs unscoped — so a member's smart list would be populated with **leads across every owner**, and the dialer would then dial leads the member doesn't own. **This is the blocker.** Opening saving without fixing this leaks leads across accounts.

**Fix:** scope the membership computation to the smart list's **owner**. In `refresh_smart_list`, join/filter the matched leads to `leads.owner_id = (select owner_id from smart_lists where id = in_id)`. Admin-owned lists still resolve to that admin's leads (admins own their leads like anyone). Net: a smart list only ever contains its owner's leads — matching how every other per-user surface behaves.

## Changes

### DB (migration — apply BEFORE the code deploy)

1. **`refresh_smart_list`**: add owner-scoping to the membership query (the fix above). This is safe to ship ahead of the code change — it only _narrows_ results, and today only admins own lists.
2. **`smart_lists` RLS**: replace `smart_lists_admin_all` with owner-or-admin policies for select/insert/update/delete (mirror the `leads` / `goals` owner-or-admin pattern). `with check (owner_id = auth.uid() or is_admin(...))`.
3. **`smart_list_members` RLS**: same owner-or-admin treatment (its rows are owned transitively via `smart_list_id → smart_lists.owner_id`). Service role still bypasses for the cron refresh.

### Code

- `src/lib/smart-lists/actions.ts`: replace `requireAdmin()` with an auth-only check in `saveSmartList`, `matchingLeadIds`, `deleteSmartList`. Keep `owner_id: userId` on insert; update/delete already scope by id + RLS backstops ownership. (Two-layer auth: code sets owner, RLS enforces it.)
- Audit `refreshAttachedSmartList` (campaigns actions) + `src/lib/smart-lists/cache.ts` + the dial-queue read path — confirm none assume admin and none cross owners now that members own lists.

### UI

- `src/app/(app)/leads/filter-builder.tsx`: the `canSaveSmartList` prop (admin-only per #340) → true for members too. The "Save as smart list" affordance appears for everyone; saved lists are per-user (already owner-scoped in the picker).
- Campaign settings "…or a smart list" picker already lists the user's own smart lists (RLS) — no change.

## Migration sequencing

1. Ship the **`refresh_smart_list` owner-scoping** migration first (safe: narrows only; admins unaffected).
2. Ship the **RLS** migration (fail-closed: members still can't write until the code drops the admin gate — RLS alone won't grant it without the code path).
3. Deploy the **code** (drop `requireAdmin`) — now members can save, and both layers agree.

## Risks / notes

- The whole point is the `refresh_smart_list` fix — **review that SQL carefully** before shipping. A missed owner filter = cross-account lead leak into the dialer.
- Verify at the component level (read a member's smart-list membership after a refresh and confirm it contains only their leads) — do **not** test by attaching to a live campaign and dialing (per the no-live-external-test-writes guardrail).
- Smart-list _deletion_ cascades to `smart_list_members` (FK on delete cascade) — fine.

## Open questions

1. Should a member be able to attach **their own** smart list to a campaign but not someone else's? (Yes — the picker is already RLS-scoped to owned lists, so this falls out for free.)
2. Any per-user cap on number of smart lists (to bound the cron refresh cost)? (Recommend: not for v1; revisit if the refresh cron gets heavy.)
