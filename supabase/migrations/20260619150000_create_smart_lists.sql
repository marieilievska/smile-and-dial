-- Smart Lists: a saved advanced-filter recipe. Release 1 stores + reuses them
-- for viewing/exporting; Release 2 adds membership cache + campaign attachment.
create table if not exists public.smart_lists (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  description text,
  filter jsonb not null default '{"combinator":"and","children":[]}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.smart_lists is
  'A saved advanced-filter recipe over leads. filter = a JSONB AND/OR tree.';

create index if not exists smart_lists_owner_idx on public.smart_lists (owner_id);

alter table public.smart_lists enable row level security;

-- Admin-managed surface (matches campaigns). Admins do everything; the
-- service role bypasses RLS for the Release 2 refresh.
create policy "smart_lists_admin_all" on public.smart_lists
  for all to authenticated
  using (public.is_admin((select auth.uid())))
  with check (public.is_admin((select auth.uid())));
