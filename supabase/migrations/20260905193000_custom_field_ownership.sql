-- Custom fields: everyone can use every field; only the creator edits it.
--
-- Product decision (owner, 2026-09-05): everyone can see and use all custom
-- fields; a user can only edit or delete the fields they created; anyone can
-- add their own. Until now UPDATE was `true` for every signed-in user
-- (20260802120000) and DELETE was admin-only.
--
-- Changes
--   1. custom_field_defs.created_by, default auth.uid(), backfilled to the
--      workspace admin (the only person who has created fields so far).
--   2. insert: created_by must be the caller (the default fills it).
--      update: the creator only. Plus one safety valve: a field with NO
--      creator (created_by null -- rows the ElevenLabs post-call webhook
--      auto-creates with the service role, seed scripts, or a creator whose
--      account was deleted, which sets it null) may be edited by an admin,
--      because otherwise nobody could ever touch it.
--      delete: the creator, or an admin. Admins keep delete on purpose: a
--      field whose creator left would otherwise be stuck forever, and a
--      stuck field is likely enough over time to be worth it.
--   3. move_custom_field(): reordering swaps sort_order on TWO rows -- the
--      one being moved and its neighbour -- and the neighbour is usually
--      someone else's. Under the creator-only UPDATE policy the second write
--      would silently fail and leave the order half-swapped. So the swap is
--      a SECURITY DEFINER function that checks the caller may move the
--      field they picked (creator, or admin for an orphan) and then swaps
--      with the adjacent row regardless of who created that one: position in
--      a shared list is not part of a field's definition.

-- ---------------------------------------------------------------------------
-- 1) created_by
-- ---------------------------------------------------------------------------
alter table public.custom_field_defs
  add column if not exists created_by uuid
    references auth.users (id) on delete set null
    default auth.uid();

comment on column public.custom_field_defs.created_by is
  'Who created the field. Only the creator may edit it (an admin may edit or '
  'delete one with no creator); the creator or an admin may delete it. Null '
  'for rows created with the service role or whose creator was deleted.';

update public.custom_field_defs
   set created_by = (
     select p.id from public.profiles p
      where p.role = 'admin'
      order by p.created_at asc
      limit 1
   )
 where created_by is null;

create index if not exists custom_field_defs_created_by_idx
  on public.custom_field_defs (created_by);

-- ---------------------------------------------------------------------------
-- 2) RLS. custom_field_defs_select stays (true) -- everyone uses every field.
-- ---------------------------------------------------------------------------
drop policy if exists "custom_field_defs_insert" on public.custom_field_defs;
create policy "custom_field_defs_insert"
  on public.custom_field_defs
  for insert
  to authenticated
  with check (created_by = (select auth.uid()));

drop policy if exists "custom_field_defs_update" on public.custom_field_defs;
create policy "custom_field_defs_update"
  on public.custom_field_defs
  for update
  to authenticated
  using (
    created_by = (select auth.uid())
    or (created_by is null and public.is_admin((select auth.uid())))
  )
  with check (
    created_by = (select auth.uid())
    or (created_by is null and public.is_admin((select auth.uid())))
  );

drop policy if exists "custom_field_defs_delete" on public.custom_field_defs;
create policy "custom_field_defs_delete"
  on public.custom_field_defs
  for delete
  to authenticated
  using (
    created_by = (select auth.uid())
    or public.is_admin((select auth.uid()))
  );

-- ---------------------------------------------------------------------------
-- 3) Reorder
-- ---------------------------------------------------------------------------
-- Returns 'moved', 'at_edge' (nothing above / below it), 'not_owner' (the
-- caller may not move this field) or 'not_found'.
create or replace function public.move_custom_field(in_id uuid, in_direction text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_cur public.custom_field_defs%rowtype;
  v_nb public.custom_field_defs%rowtype;
begin
  if v_uid is null then
    raise exception 'move_custom_field requires an authenticated caller';
  end if;
  if in_direction not in ('up', 'down') then
    raise exception 'direction must be ''up'' or ''down''';
  end if;

  -- Same test as the UPDATE policy: the creator, or an admin for an orphan.
  select * into v_cur
    from public.custom_field_defs
   where id = in_id
   for update;
  if not found then
    return 'not_found';
  end if;
  if v_cur.created_by is distinct from v_uid
     and not (v_cur.created_by is null and public.is_admin(v_uid)) then
    return 'not_owner';
  end if;

  -- Normalise to a dense 0..n-1 order first (stable on created_at, id) so two
  -- fields sharing a sort_order can't make the swap below a no-op.
  update public.custom_field_defs f
     set sort_order = r.rn
    from (
      select id, (row_number() over (order by sort_order, created_at, id) - 1)::integer as rn
        from public.custom_field_defs
    ) r
   where r.id = f.id
     and f.sort_order is distinct from r.rn;

  select * into v_cur from public.custom_field_defs where id = in_id;

  select * into v_nb
    from public.custom_field_defs
   where sort_order = case
           when in_direction = 'up' then v_cur.sort_order - 1
           else v_cur.sort_order + 1
         end
   for update;
  if not found then
    return 'at_edge';
  end if;

  update public.custom_field_defs set sort_order = v_nb.sort_order where id = v_cur.id;
  update public.custom_field_defs set sort_order = v_cur.sort_order where id = v_nb.id;
  return 'moved';
end;
$$;

comment on function public.move_custom_field(uuid, text) is
  'Swap a custom field''s sort_order with its neighbour (''up'' / ''down''). '
  'Allowed for the field''s creator, or an admin when it has no creator. '
  'Returns moved | at_edge | not_owner | not_found.';

-- Called with the cookie client from src/lib/custom-fields/actions.ts
-- (moveCustomField). Never anon.
revoke execute on function public.move_custom_field(uuid, text) from public, anon;
grant execute on function public.move_custom_field(uuid, text) to authenticated;
