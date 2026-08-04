-- Open smart-list ownership to members (builders), scoped to their own data.
--
-- Smart lists were admin-only. To let a member save + own a smart list safely,
-- two things must change together:
--
--   1. refresh_smart_list() is SECURITY DEFINER, so RLS is OFF inside it and the
--      (security-invoker) leads_matching_filter() it calls also sees EVERY
--      owner's leads. With members owning lists, that would populate a member's
--      list with other accounts' leads — and the dialer would call them. Fix:
--      scope inserted members to the LIST OWNER's leads. (This also corrects a
--      latent cross-owner dial for admin-owned lists, which previously spanned
--      all leads; an owner's list now contains only that owner's leads.)
--
--   2. RLS on smart_lists / smart_list_members: owner-or-admin instead of
--      admin-only, mirroring leads / goals / campaigns.
--
-- Fail-closed ordering: apply this BEFORE the code that drops the requireAdmin
-- gate. Until the code lands, members still can't write (the actions gate them),
-- and the narrowed refresh only ever reduces membership.

-- 1. Owner-scoped membership refresh -----------------------------------------
create or replace function public.refresh_smart_list(in_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_filter jsonb;
  v_owner uuid;
  v_count integer;
begin
  select filter, owner_id into v_filter, v_owner
  from public.smart_lists where id = in_id;
  if v_filter is null then
    delete from public.smart_list_members where smart_list_id = in_id;
    return 0;
  end if;

  delete from public.smart_list_members where smart_list_id = in_id;
  -- Only the list OWNER's (non-deleted) leads. Without the owner join this
  -- SECURITY DEFINER function would match every account's leads.
  insert into public.smart_list_members (smart_list_id, lead_id)
  select in_id, lf.lead_id
  from public.leads_matching_filter(v_filter) as lf(lead_id)
  join public.leads l on l.id = lf.lead_id
  where l.owner_id = v_owner
    and l.deleted_at is null
  on conflict do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

grant execute on function public.refresh_smart_list(uuid) to authenticated, service_role;

-- 2. Owner-or-admin RLS ------------------------------------------------------
drop policy if exists "smart_lists_admin_all" on public.smart_lists;
create policy "smart_lists_owner_or_admin" on public.smart_lists
  for all to authenticated
  using (
    owner_id = (select auth.uid())
    or public.is_admin((select auth.uid()))
  )
  with check (
    owner_id = (select auth.uid())
    or public.is_admin((select auth.uid()))
  );

drop policy if exists "smart_list_members_admin_all" on public.smart_list_members;
create policy "smart_list_members_owner_or_admin" on public.smart_list_members
  for all to authenticated
  using (
    public.is_admin((select auth.uid()))
    or exists (
      select 1 from public.smart_lists sl
      where sl.id = smart_list_members.smart_list_id
        and sl.owner_id = (select auth.uid())
    )
  )
  with check (
    public.is_admin((select auth.uid()))
    or exists (
      select 1 from public.smart_lists sl
      where sl.id = smart_list_members.smart_list_id
        and sl.owner_id = (select auth.uid())
    )
  );
