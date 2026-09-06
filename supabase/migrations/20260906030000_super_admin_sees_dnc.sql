-- The super admin sees every do-not-call list.
--
-- Product decision (owner, 2026-09-06), resolving a direct conflict between
-- two earlier ones:
--   * 20260905192000 -- "the DNC list is private per person", deliberately
--     with NO admin branch, so one teammate never sees another's suppressions.
--   * 20260906010000 -- "super admin sees all, literally all".
-- The super admin wins. Compliance oversight is the whole point of that role:
-- somebody has to be able to answer "did we call a business that asked us to
-- stop?" across the workspace, and nobody could.
--
-- Scope of the exception: `is_admin()` has meant super_admin ONLY since
-- 20260906010000, so `or is_admin(auth.uid())` grants exactly one role. A
-- plain admin still sees only their own list; this is the same one-line idiom
-- the other 72 owner-scoped policies already use, which is the point -- DNC
-- stops being the odd table out.
--
-- Enforcement is NOT touched. It stays per person (20260906020000): the
-- dial_queue anti-join, pre_call_check and is_phone_on_dnc all still match
-- owner-to-owner, so seeing another user's entry does not make it block your
-- calls, and this migration cannot change who is dialable. Visibility only.
--
-- DELETE moves with SELECT on purpose. The /dnc page renders a remove control
-- on every row it can see (there is no admin gate any more -- see the comment
-- in src/app/(app)/dnc/page.tsx), so a super admin who could see but not
-- remove would get a button that errors. Removal stays audited: the
-- dnc_removals insert policy still demands removed_by_user_id = auth.uid(),
-- so the log names whoever actually did it.
--
-- INSERT is unchanged (own rows, or a null owner the BEFORE trigger stamps
-- with auth.uid()). A super admin adding a number puts it on their OWN list,
-- never someone else's -- cross-user writes belong to the handover work, not
-- here. There is still no UPDATE policy on either table.

-- ---------------------------------------------------------------------------
-- dnc_entries: read + remove any entry as the super admin
-- ---------------------------------------------------------------------------
drop policy if exists "dnc_entries_select" on public.dnc_entries;
create policy "dnc_entries_select"
  on public.dnc_entries
  for select
  to authenticated
  using (
    owner_id = (select auth.uid())
    or public.is_admin((select auth.uid()))
  );

drop policy if exists "dnc_entries_delete" on public.dnc_entries;
create policy "dnc_entries_delete"
  on public.dnc_entries
  for delete
  to authenticated
  using (
    owner_id = (select auth.uid())
    or public.is_admin((select auth.uid()))
  );

comment on table public.dnc_entries is
  'Do-not-call list. Each user sees and manages only their own entries; the '
  'super admin sees and manages every user''s. Dial-time enforcement is '
  'per owner: a number blocks the calls of the user whose list it is on.';

-- ---------------------------------------------------------------------------
-- dnc_removals: the audit trail the oversight actually needs
-- ---------------------------------------------------------------------------
drop policy if exists "dnc_removals_select" on public.dnc_removals;
create policy "dnc_removals_select"
  on public.dnc_removals
  for select
  to authenticated
  using (
    removed_by_user_id = (select auth.uid())
    or public.is_admin((select auth.uid()))
  );

comment on table public.dnc_removals is
  'Audit log of every DNC removal, with reason text. Each user sees their own '
  'removals; the super admin sees all of them.';
