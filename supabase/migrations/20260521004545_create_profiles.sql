-- Profiles: one application profile row per authenticated user.
-- See BUILD_PLAN.md Section 3 (profiles) and Section 16 (auth & security).

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  email text,
  avatar_url text,
  role text not null default 'member' check (role in ('admin', 'member')),
  last_login_at timestamptz,
  active boolean not null default true,
  notify_on_goal_met boolean not null default true,
  notify_on_email_reply boolean not null default true,
  created_at timestamptz not null default now()
);

comment on table public.profiles is 'Application profile for each authenticated user.';

-- ---------------------------------------------------------------------------
-- is_admin: true when the given user exists, is active, and has the admin role.
-- SECURITY DEFINER so policies can call it without recursing into profiles RLS.
-- ---------------------------------------------------------------------------
create function public.is_admin(uid uuid)
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
      and role = 'admin'
      and active = true
  );
$$;

-- ---------------------------------------------------------------------------
-- Row-Level Security: members see only their own profile; admins see all.
-- Inserts/updates/deletes are admin-only (the signup trigger below bypasses
-- RLS via SECURITY DEFINER). Member self-service edits are added later with
-- the Settings > Profile page.
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;

create policy "profiles_select"
  on public.profiles
  for select
  to authenticated
  using (id = (select auth.uid()) or public.is_admin((select auth.uid())));

create policy "profiles_insert"
  on public.profiles
  for insert
  to authenticated
  with check (public.is_admin((select auth.uid())));

create policy "profiles_update"
  on public.profiles
  for update
  to authenticated
  using (public.is_admin((select auth.uid())))
  with check (public.is_admin((select auth.uid())));

create policy "profiles_delete"
  on public.profiles
  for delete
  to authenticated
  using (public.is_admin((select auth.uid())));

-- ---------------------------------------------------------------------------
-- handle_new_user: create a profile row whenever an auth user is created.
-- Role and full name are read from the user metadata supplied at creation.
-- ---------------------------------------------------------------------------
create function public.handle_new_user()
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
    case
      when new.raw_user_meta_data ->> 'role' = 'admin' then 'admin'
      else 'member'
    end
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();
