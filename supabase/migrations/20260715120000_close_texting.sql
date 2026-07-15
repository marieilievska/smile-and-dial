-- Close texting (SMS) — Phase 2. Additive only (safe to push before/after code).
-- Mirrors the email model: sms_templates (like email_templates, no subject) +
-- texts (like emails, phone instead of address) + per-campaign template +
-- per-lead mobile + per-owner send-from number.

create table if not exists public.sms_templates (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  name text not null,
  body text not null,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists sms_templates_owner_id_idx
  on public.sms_templates (owner_id, name);

alter table public.sms_templates enable row level security;

drop policy if exists "sms_templates_select" on public.sms_templates;
create policy "sms_templates_select"
  on public.sms_templates
  for select
  to authenticated
  using (
    owner_id = (select auth.uid())
    or public.is_admin((select auth.uid()))
  );

drop policy if exists "sms_templates_owner_write" on public.sms_templates;
create policy "sms_templates_owner_write"
  on public.sms_templates
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

create table if not exists public.texts (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id) on delete cascade,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  campaign_id uuid references public.campaigns (id) on delete set null,
  call_id uuid references public.calls (id) on delete set null,
  direction text not null check (direction in ('sent', 'received')),
  body text,
  to_number text,
  from_number text,
  close_message_id text,
  status text not null default 'queued'
    check (status in ('queued', 'sent', 'failed', 'received')),
  template_id uuid references public.sms_templates (id) on delete set null,
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists texts_lead_id_idx
  on public.texts (lead_id, created_at desc);
create index if not exists texts_owner_id_idx
  on public.texts (owner_id, created_at desc);
create index if not exists texts_close_message_id_idx
  on public.texts (close_message_id);

alter table public.texts enable row level security;

drop policy if exists "texts_select" on public.texts;
create policy "texts_select"
  on public.texts
  for select
  to authenticated
  using (
    owner_id = (select auth.uid())
    or public.is_admin((select auth.uid()))
  );

-- Per-campaign fixed SMS template the send_text tool sends verbatim.
alter table public.campaigns
  add column if not exists sms_template_id uuid
    references public.sms_templates (id) on delete set null;

-- The confirmed mobile to text (the dialed business_phone is usually a landline).
alter table public.leads
  add column if not exists mobile_phone text;

-- The Close SMS-enabled "internal" number this owner texts FROM (E.164).
alter table public.user_integrations
  add column if not exists close_sms_from_number text;
