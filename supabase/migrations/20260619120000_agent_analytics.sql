-- Agent Analytics (admin-only) — storage for the Market Research ops page.
-- Additive ONLY: two nullable columns on calls + three new tables. Nothing is
-- dropped or renamed, so this is safe to apply before the UI ships.

-- 1. Per-call annotations edited on the Voice of Customer tab.
alter table public.calls
  add column if not exists theme text,
  add column if not exists suggested_action text;

comment on column public.calls.theme is
  'Agent Analytics: operator-tagged theme for a call''s research answer.';
comment on column public.calls.suggested_action is
  'Agent Analytics: operator-written suggested action for a call.';

-- 2. Hot leads — the sell list. Seeded once per "interested = yes" call, then
--    worked by the team (status / owner / next step / date contacted).
create table if not exists public.hot_leads (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null unique references public.calls (id) on delete cascade,
  lead_id uuid references public.leads (id) on delete set null,
  session_date date,
  contact_name text,
  why_hot text,
  call_length_seconds integer,
  interest text,
  current_ai_tool text,
  owner text,
  status text not null default 'New',
  next_step text,
  date_contacted date,
  created_at timestamptz not null default now()
);

comment on table public.hot_leads is
  'Agent Analytics sell list: one row per yes-interest Market Research call, '
  'with team-edited status/owner/next-step. Unique call_id = seeded once.';

create index if not exists hot_leads_session_date_idx
  on public.hot_leads (session_date desc);

-- 3. App changelog (manual log).
create table if not exists public.app_changelog (
  id uuid primary key default gen_random_uuid(),
  change_date date not null default current_date,
  area text,
  change_type text,
  summary text,
  details text,
  status text not null default 'Open',
  owner text,
  ticket_link text,
  created_at timestamptz not null default now()
);

-- 4. Agent prompt log (manual log).
create table if not exists public.agent_prompt_log (
  id uuid primary key default gen_random_uuid(),
  log_date date not null default current_date,
  version text,
  changed text not null default 'No change',
  what_changed text,
  why text,
  full_prompt text,
  created_at timestamptz not null default now()
);

-- Row-Level Security. These are admin-only surfaces; the service-role server
-- actions bypass RLS, and these policies gate any authenticated (non-service)
-- access to admins only — defense in depth behind the page's admin route guard.
alter table public.hot_leads enable row level security;
alter table public.app_changelog enable row level security;
alter table public.agent_prompt_log enable row level security;

create policy "hot_leads_admin_all" on public.hot_leads
  for all to authenticated
  using (public.is_admin((select auth.uid())))
  with check (public.is_admin((select auth.uid())));

create policy "app_changelog_admin_all" on public.app_changelog
  for all to authenticated
  using (public.is_admin((select auth.uid())))
  with check (public.is_admin((select auth.uid())));

create policy "agent_prompt_log_admin_all" on public.agent_prompt_log
  for all to authenticated
  using (public.is_admin((select auth.uid())))
  with check (public.is_admin((select auth.uid())));
