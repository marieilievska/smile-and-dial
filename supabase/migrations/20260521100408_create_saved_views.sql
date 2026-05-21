-- Saved views: a named filter + column combination, private to each user.
-- See BUILD_PLAN.md Section 5.1 (Leads — Saved views).

create table public.saved_views (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  page text not null,
  name text not null,
  params text not null default '',
  created_at timestamptz not null default now()
);

comment on table public.saved_views is 'Per-user named filter/column presets for list pages.';

create index saved_views_user_page_idx on public.saved_views (user_id, page);

-- Saved views are strictly private to the user who created them.
alter table public.saved_views enable row level security;

create policy "saved_views_all"
  on public.saved_views
  for all
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
