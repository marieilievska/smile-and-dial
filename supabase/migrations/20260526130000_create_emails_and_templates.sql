-- Close integration (Step 38 / BUILD_PLAN §12).
-- email_templates (workspace-shared) + emails (per-lead direction-tagged).

alter table public.app_settings
  add column if not exists close_api_key text,
  add column if not exists close_connected_at timestamptz;

create table if not exists public.email_templates (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  name text not null,
  subject text not null,
  body text not null,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists email_templates_owner_id_idx
  on public.email_templates (owner_id, name);

alter table public.email_templates enable row level security;

drop policy if exists "email_templates_select" on public.email_templates;
create policy "email_templates_select"
  on public.email_templates
  for select
  to authenticated
  using (
    owner_id = (select auth.uid())
    or public.is_admin((select auth.uid()))
  );

drop policy if exists "email_templates_owner_write" on public.email_templates;
create policy "email_templates_owner_write"
  on public.email_templates
  for all
  to authenticated
  using (
    owner_id = (select auth.uid())
    or public.is_admin((select auth.uid()))
  )
  with check (
    owner_id = (select auth.uid())
    or public.is_admin((select auth.uid()))
  );

create table if not exists public.emails (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id) on delete cascade,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  campaign_id uuid references public.campaigns (id) on delete set null,
  call_id uuid references public.calls (id) on delete set null,
  direction text not null check (direction in ('sent', 'received')),
  subject text,
  body text,
  to_address text,
  from_address text,
  close_message_id text,
  status text not null default 'queued'
    check (status in ('queued', 'sent', 'failed', 'received')),
  template_id uuid references public.email_templates (id) on delete set null,
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists emails_lead_id_idx
  on public.emails (lead_id, created_at desc);
create index if not exists emails_owner_id_idx
  on public.emails (owner_id, created_at desc);
create index if not exists emails_close_message_id_idx
  on public.emails (close_message_id);

alter table public.emails enable row level security;

drop policy if exists "emails_select" on public.emails;
create policy "emails_select"
  on public.emails
  for select
  to authenticated
  using (
    owner_id = (select auth.uid())
    or public.is_admin((select auth.uid()))
  );
