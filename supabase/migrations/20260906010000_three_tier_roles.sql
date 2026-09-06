-- Three role tiers: super_admin, admin, member.
--
-- Product decision (owner, 2026-09-06). Two INDEPENDENT axes -- what you can
-- SEE, and what you are allowed to DO:
--
--   super_admin  sees everything belonging to everyone, and can do everything:
--                move things between two other people, workspace secrets and
--                settings, the wipe, the maintenance jobs.
--   admin        sees ONLY what they own. Does their own work, PLUS
--                invite / deactivate / remove people, PLUS hand over things
--                they own, PLUS create and edit agent templates.
--   member       sees only what they own. Own work only.
--
-- Why this is a small migration rather than a rewrite of 84 policies:
--
--   Every owner-scoped policy in this database already reads
--       owner_id = (select auth.uid()) or public.is_admin((select auth.uid()))
--   which IS the new model as long as `is_admin` means "the role that sees
--   everything". So `is_admin` is REDEFINED here to mean super_admin, and all
--   84 policies follow automatically. Only the handful of policies that mean
--   "elevated power" rather than "sees everything" are re-pointed by hand at
--   the new `can_manage_users` -- see sections 5 and 6.
--
-- Live accounts at the time of writing:
--   marie@referrizer.com      admin       (owns every lead / number / campaign
--                                          / list / agent, so "sees only what
--                                          they own" costs her nothing today)
--   marketing@referrizer.com  member      (owns nothing)
--   aicoach@referrizer.com    member  ->  super_admin (section 9)

-- ---------------------------------------------------------------------------
-- 1) profiles.role: add the third tier to the CHECK constraint.
-- ---------------------------------------------------------------------------
alter table public.profiles drop constraint if exists profiles_role_check;

-- Belt-and-braces: the original constraint (20260521004545) was declared
-- inline on the column, so Postgres auto-named it `profiles_role_check` and
-- the line above is enough. If any environment ever ended up with the same
-- rule under a different name, the promotion at the end of this file would
-- fail on it; sweep any leftover CHECK on this table that mentions `role`.
-- profiles has no other CHECK constraint, so nothing else can match.
do $$
declare c record;
begin
  for c in
    select con.conname
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace ns on ns.oid = rel.relnamespace
     where ns.nspname = 'public'
       and rel.relname = 'profiles'
       and con.contype = 'c'
       and pg_get_constraintdef(con.oid) ilike '%role%'
  loop
    execute format('alter table public.profiles drop constraint %I', c.conname);
  end loop;
end
$$;

alter table public.profiles
  add constraint profiles_role_check
  check (role in ('super_admin', 'admin', 'member'));

comment on column public.profiles.role is
  'super_admin = sees everything and can do everything; admin = sees only what '
  'they own but may manage teammates, hand over what they own and curate agent '
  'templates; member = sees only what they own, own work only.';

-- ---------------------------------------------------------------------------
-- 2) is_super_admin: the full-data-visibility role. Same shape as the original
--    is_admin from 20260521004545 -- SECURITY DEFINER so a policy can call it
--    without recursing into the profiles RLS, empty search_path, stable.
-- ---------------------------------------------------------------------------
create or replace function public.is_super_admin(uid uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1
    from public.profiles
    where id = uid
      and role = 'super_admin'
      and active = true
  );
$$;

comment on function public.is_super_admin(uuid) is
  'True when the user is an ACTIVE super admin: the tier that sees every row '
  'belonging to everyone. This is the predicate behind is_admin(); prefer '
  'calling this one directly in new policies.';

-- ---------------------------------------------------------------------------
-- 3) is_admin: KEPT AS A LEGACY NAME, redefined to mean super_admin.
--
--    84 existing policies say `public.is_admin((select auth.uid()))` and they
--    all mean "this role sees everything", which is now super_admin. Renaming
--    the symbol would mean rewriting all of them in one migration; redefining
--    the body moves them all at once, with no window where a policy points at
--    a function that does not exist yet.
-- ---------------------------------------------------------------------------
create or replace function public.is_admin(uid uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select public.is_super_admin(uid);
$$;

comment on function public.is_admin(uuid) is
  'LEGACY NAME. Since 20260906010000 this means "the full-data-visibility '
  'role", i.e. is_super_admin(uid), NOT "has the admin role". The ~84 '
  'owner-scoped RLS policies that read `owner_id = auth.uid() or '
  'is_admin(auth.uid())` all mean visibility, so they keep working unchanged. '
  'ADMIN-TIER POWERS (invite / deactivate / remove people, hand over what you '
  'own, curate agent templates) use can_manage_users(uid) instead. Do not '
  '"fix" this function to check role = ''admin''.';

-- ---------------------------------------------------------------------------
-- 4) can_manage_users: the elevated-power predicate. Both top tiers.
-- ---------------------------------------------------------------------------
create or replace function public.can_manage_users(uid uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1
    from public.profiles
    where id = uid
      and role in ('admin', 'super_admin')
      and active = true
  );
$$;

comment on function public.can_manage_users(uuid) is
  'True for an ACTIVE admin or super admin: the tiers allowed to invite, '
  'deactivate and remove teammates, hand over rows they own, and curate agent '
  'templates. Says NOTHING about data visibility, which is is_admin() / '
  'is_super_admin().';

-- All three are evaluated INSIDE RLS policies, which run as the calling role,
-- so `authenticated` needs EXECUTE (see the reminder in 20260905170000: new
-- functions start closed). Never anon: an anonymous caller has no auth.uid()
-- and no business asking who is an admin.
revoke execute on function public.is_super_admin(uuid) from public, anon;
grant execute on function public.is_super_admin(uuid) to authenticated;

revoke execute on function public.is_admin(uuid) from public, anon;
grant execute on function public.is_admin(uuid) to authenticated;

revoke execute on function public.can_manage_users(uuid) from public, anon;
grant execute on function public.can_manage_users(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5) profiles: the teammate directory is a POWER surface, not a data surface.
--
--    SELECT  self, or anyone who can manage users. An admin who can invite and
--            deactivate people must be able to list them; without this branch
--            the Users page would show a plain admin only their own row.
--    WRITE   can_manage_users, plus two guards:
--              (a) nobody may edit their own profile row through the table, so
--                  nobody can change their own role or reactivate themselves.
--                  Self-service goes through update_my_profile(jsonb)
--                  (20260905190000), which is SECURITY DEFINER, touches only
--                  the caller's row and only the four harmless columns, and
--                  therefore keeps working for every role.
--                  RLS cannot compare NEW.role to OLD.role, so "cannot change
--                  their own role" is enforced as "cannot write their own row
--                  here" -- strictly stronger, and nothing in the app needs
--                  the weaker version.
--              (b) a row whose role is super_admin may only be created or
--                  touched by a super admin. A plain admin can neither mint a
--                  super admin nor demote, deactivate or delete one. The
--                  guard sits in USING (the existing row) and in WITH CHECK
--                  (the resulting row), so it blocks both directions.
-- ---------------------------------------------------------------------------
drop policy if exists "profiles_select" on public.profiles;
create policy "profiles_select"
  on public.profiles
  for select
  to authenticated
  using (
    id = (select auth.uid())
    or public.can_manage_users((select auth.uid()))
  );

drop policy if exists "profiles_insert" on public.profiles;
create policy "profiles_insert"
  on public.profiles
  for insert
  to authenticated
  with check (
    public.can_manage_users((select auth.uid()))
    and (role <> 'super_admin' or public.is_super_admin((select auth.uid())))
  );

drop policy if exists "profiles_update" on public.profiles;
create policy "profiles_update"
  on public.profiles
  for update
  to authenticated
  using (
    public.can_manage_users((select auth.uid()))
    and id <> (select auth.uid())
    and (role <> 'super_admin' or public.is_super_admin((select auth.uid())))
  )
  with check (
    public.can_manage_users((select auth.uid()))
    and id <> (select auth.uid())
    and (role <> 'super_admin' or public.is_super_admin((select auth.uid())))
  );

drop policy if exists "profiles_delete" on public.profiles;
create policy "profiles_delete"
  on public.profiles
  for delete
  to authenticated
  using (
    public.can_manage_users((select auth.uid()))
    and id <> (select auth.uid())
    and (role <> 'super_admin' or public.is_super_admin((select auth.uid())))
  );

-- ---------------------------------------------------------------------------
-- 6) agent_templates: curating the shared template shelf is an admin-tier
--    power, not "sees everything". Reading stays open to everyone (unchanged).
-- ---------------------------------------------------------------------------
drop policy if exists "agent_templates_write" on public.agent_templates;
create policy "agent_templates_write"
  on public.agent_templates
  for all
  to authenticated
  using (public.can_manage_users((select auth.uid())))
  with check (public.can_manage_users((select auth.uid())));

-- ---------------------------------------------------------------------------
-- 7) leads: "hand over things they own".
--
--    USING is unchanged -- an admin still reaches only rows they own, exactly
--    like a member. Only WITH CHECK gains a branch, so the admin tier may set
--    a DIFFERENT owner_id on a row it already owns. Without this, the bulk
--    "Reassign owner" action (src/lib/leads/bulk-actions.ts) would pass USING
--    and then fail WITH CHECK the moment the new owner is somebody else.
--    A member still cannot give a lead away, and nobody gains the ability to
--    touch a lead they do not own.
-- ---------------------------------------------------------------------------
drop policy if exists "leads_update" on public.leads;
create policy "leads_update"
  on public.leads
  for update
  to authenticated
  using (
    owner_id = (select auth.uid()) or public.is_admin((select auth.uid()))
  )
  with check (
    owner_id = (select auth.uid())
    or public.is_admin((select auth.uid()))
    or public.can_manage_users((select auth.uid()))
  );

-- ---------------------------------------------------------------------------
-- 8) handle_new_user: a signup must never choose its own role.
--
--    The 20260521004545 version copied `raw_user_meta_data ->> 'role'` into
--    profiles.role. raw_user_meta_data is attacker-controlled on a self-serve
--    signup (it is the `data` payload of supabase.auth.signUp), so anyone who
--    could create an account could hand themselves the admin role. Now the
--    trigger ALWAYS writes 'member'; the invite path sets the real role
--    afterwards with the service-role client (src/lib/users/actions.ts,
--    inviteUser), which is authorised code rather than user input.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    'member'
  );
  return new;
end;
$$;

comment on function public.handle_new_user() is
  'Creates the profile row for a new auth user. ALWAYS role = ''member'': the '
  'role is deliberately NOT read from raw_user_meta_data, which the signup '
  'itself controls. inviteUser sets the invited role afterwards with the '
  'service-role client.';

-- ---------------------------------------------------------------------------
-- 9) Promote the workspace owner's account to super_admin.
--
--    Guarded twice: a no-op if the account does not exist in this database
--    (a fresh local stack, a preview branch), and a no-op if it is already
--    super_admin. marie@ stays `admin` and marketing@ stays `member` on
--    purpose -- see the header.
-- ---------------------------------------------------------------------------
update public.profiles p
   set role = 'super_admin'
 where p.role <> 'super_admin'
   and exists (
     select 1
       from auth.users u
      where u.id = p.id
        and lower(u.email) = 'aicoach@referrizer.com'
   );
