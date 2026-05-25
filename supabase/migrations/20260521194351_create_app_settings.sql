-- Workspace-wide configuration. A single row (id = 1) holds integration
-- settings; later phases add Calendly, Close, and cost-rate columns.
-- See BUILD_PLAN.md Section 13 (Integrations).

create table public.app_settings (
  id integer primary key default 1 check (id = 1),
  elevenlabs_api_key text,
  elevenlabs_voice_ids text,
  updated_at timestamptz not null default now()
);

comment on table public.app_settings is 'Workspace-wide configuration (single row).';

-- ---------------------------------------------------------------------------
-- Row-Level Security: integration settings are read and written by admins
-- only. No insert/delete policies — the single row is seeded here and the
-- table can never gain or lose rows.
-- ---------------------------------------------------------------------------
alter table public.app_settings enable row level security;

create policy "app_settings_select"
  on public.app_settings
  for select
  to authenticated
  using (public.is_admin((select auth.uid())));

create policy "app_settings_update"
  on public.app_settings
  for update
  to authenticated
  using (public.is_admin((select auth.uid())))
  with check (public.is_admin((select auth.uid())));

insert into public.app_settings (id) values (1);
