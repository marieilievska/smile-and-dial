-- Per-user do-not-call lists; workspace-wide enforcement.
--
-- Product decision (owner, 2026-09-05): every user works in their own slice.
-- "If I have DNC numbers, a new member should not see those" -- and that
-- applies to other admins too, so unlike leads / lists / campaigns there is
-- NO admin branch on the DNC read policy. The DIALER, however, must still
-- refuse a number that ANY user has marked do-not-call: a person who asked
-- not to be called must not get a call from another teammate. Visibility is
-- per user; enforcement stays workspace-wide.
--
-- What changes
--   1. dnc_entries.owner_id, backfilled to whoever added the row (or the
--      workspace admin when nobody is recorded), with a BEFORE INSERT trigger
--      that fills it for writers that don't pass one. `default auth.uid()`
--      is not enough: the ElevenLabs post-call webhook, the mark_dnc tool
--      and the Close STOP webhook all insert with the service role, where
--      auth.uid() is null. The trigger resolves, in order:
--        (a) the explicit owner_id on the row,
--        (b) auth.uid() -- the signed-in user, for cookie-client writes,
--        (c) added_by_user_id -- the webhooks attribute rows to the lead's
--            owner through this column already,
--        (d) the owner of the lead that carries this phone (live leads
--            first, most recently touched first),
--        (e) the workspace admin (oldest active admin profile).
--      None of those writers need a code change.
--   2. RLS: select / delete = own rows only; insert = own rows (or a null
--      owner the trigger fills in). No UPDATE policy, as before. Each user
--      manages their own entries -- removal is no longer admin-only, and the
--      dnc_removals audit trail is scoped the same way.
--   3. Enforcement is untouched and matches on `phone` alone, regardless of
--      owner: the dial_queue view (20260810130000), pre_call_check
--      (20260724120000) and is_phone_on_dnc (20260525152154). Do not add an
--      owner filter there.
--
-- What does NOT change (yet): `unique (phone)`.
--   The intended end state is `unique (owner_id, phone)` so two users can
--   each list the same number. That has to wait for a one-line change in
--   src/lib/elevenlabs/post-call-webhook.ts, which is owned by another
--   branch right now: it upserts with `onConflict: "phone"`, i.e.
--   `ON CONFLICT (phone) DO NOTHING`, and Postgres refuses that clause the
--   moment no unique index on exactly (phone) exists -- and that call site
--   never checks its error, so AI-detected DNC numbers would silently stop
--   being written. Until that file switches to `onConflict:
--   "owner_id,phone"`, a number stays owned by whoever listed it first; a
--   second user's add is a no-op (the dialer already blocks it for
--   everyone). A follow-up migration swaps the constraint once that lands.

-- ---------------------------------------------------------------------------
-- 1) Ownership column + backfill
-- ---------------------------------------------------------------------------
alter table public.dnc_entries
  add column if not exists owner_id uuid references auth.users (id) on delete set null;

comment on column public.dnc_entries.owner_id is
  'Whose DNC list this entry is on. RLS scopes reads and deletes to the owner; '
  'dial-time enforcement (dial_queue, pre_call_check, is_phone_on_dnc) matches '
  'on phone alone so every user''s list blocks the number for everyone.';

-- Whoever added the row keeps it; rows with no recorded adder (the AI
-- post-call path before this change) go to the single admin today.
update public.dnc_entries
   set owner_id = coalesce(
     added_by_user_id,
     (
       select p.id from public.profiles p
        where p.role = 'admin'
        order by p.created_at asc
        limit 1
     )
   )
 where owner_id is null;

create index if not exists dnc_entries_owner_id_idx
  on public.dnc_entries (owner_id);

comment on table public.dnc_entries is
  'Do-not-call list. Each user sees and manages only their own entries; the '
  'dialer refuses a phone that is on ANY user''s list.';

-- ---------------------------------------------------------------------------
-- 2) Fill owner_id for writers that don't pass one (see the order above)
-- ---------------------------------------------------------------------------
create or replace function public.dnc_entries_fill_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- (a) explicit value wins.
  if new.owner_id is not null then
    return new;
  end if;

  -- (b) the signed-in user (cookie-client inserts).
  new.owner_id := auth.uid();
  if new.owner_id is not null then
    return new;
  end if;

  -- (c) whoever the writer attributed the row to (the tool and Close
  --     webhooks pass the lead's owner here).
  new.owner_id := new.added_by_user_id;
  if new.owner_id is not null then
    return new;
  end if;

  -- (d) the owner of the lead that carries this phone. Live leads first,
  --     then the most recently touched.
  select l.owner_id
    into new.owner_id
    from public.leads l
   where l.business_phone = new.phone
      or l.mobile_phone = new.phone
      or l.owner_phone = new.phone
   order by (l.deleted_at is null) desc, l.updated_at desc
   limit 1;
  if new.owner_id is not null then
    return new;
  end if;

  -- (e) the workspace admin.
  select p.id
    into new.owner_id
    from public.profiles p
   where p.role = 'admin'
     and p.active = true
   order by p.created_at asc
   limit 1;

  return new;
end;
$$;

comment on function public.dnc_entries_fill_owner() is
  'BEFORE INSERT on dnc_entries: fills owner_id from the explicit value, else '
  'auth.uid(), else added_by_user_id, else the owner of the lead with this '
  'phone, else the workspace admin. Lets service-role writers (post-call '
  'webhook, mark_dnc tool, Close STOP) keep inserting without an owner.';

-- Fired by authenticated inserts. EXECUTE is checked at CREATE TRIGGER time,
-- not at fire time, but grant it anyway like set_updated_at (20260905170000)
-- so an ordinary "Add to DNC" can never trip on the lock-down. Calling a
-- trigger function directly is refused by Postgres, so this exposes nothing.
revoke execute on function public.dnc_entries_fill_owner() from public, anon;
grant execute on function public.dnc_entries_fill_owner() to authenticated;

drop trigger if exists dnc_entries_fill_owner on public.dnc_entries;
create trigger dnc_entries_fill_owner
  before insert on public.dnc_entries
  for each row
  execute function public.dnc_entries_fill_owner();

-- ---------------------------------------------------------------------------
-- 3) RLS: own rows only. Deliberately no is_admin() branch on any of these.
-- ---------------------------------------------------------------------------
drop policy if exists "dnc_entries_select" on public.dnc_entries;
create policy "dnc_entries_select"
  on public.dnc_entries
  for select
  to authenticated
  using (owner_id = (select auth.uid()));

-- WITH CHECK runs on the row AFTER the BEFORE trigger, so a cookie-client
-- insert that omits owner_id arrives here already stamped with auth.uid().
-- The `is null` branch is belt-and-braces for that same path.
drop policy if exists "dnc_entries_insert" on public.dnc_entries;
create policy "dnc_entries_insert"
  on public.dnc_entries
  for insert
  to authenticated
  with check (owner_id = (select auth.uid()) or owner_id is null);

drop policy if exists "dnc_entries_delete" on public.dnc_entries;
create policy "dnc_entries_delete"
  on public.dnc_entries
  for delete
  to authenticated
  using (owner_id = (select auth.uid()));

-- Removal audit log: each user sees and writes their own removals.
drop policy if exists "dnc_removals_select" on public.dnc_removals;
create policy "dnc_removals_select"
  on public.dnc_removals
  for select
  to authenticated
  using (removed_by_user_id = (select auth.uid()));

drop policy if exists "dnc_removals_insert" on public.dnc_removals;
create policy "dnc_removals_insert"
  on public.dnc_removals
  for insert
  to authenticated
  with check (removed_by_user_id = (select auth.uid()));

comment on table public.dnc_removals is
  'Audit log of every DNC removal, with reason text. Scoped per user like '
  'dnc_entries.';
