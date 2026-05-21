-- Leads and their custom field values. See BUILD_PLAN.md Sections 3 and 8.

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  list_id uuid not null references public.lists (id) on delete restrict,
  company text,
  status text not null default 'ready_to_call' check (
    status in (
      'ready_to_call', 'callback', 'resting', 'goal_met', 'attended',
      'no_show', 'closed', 'sale', 'dnc', 'email_replied'
    )
  ),
  last_outcome text check (
    last_outcome is null
    or last_outcome in (
      'voicemail', 'no_answer', 'busy', 'failed', 'hung_up_immediately',
      'invalid_number', 'gatekeeper', 'not_interested', 'callback', 'dnc',
      'goal_met', 'language_barrier', 'ai_receptionist', 'ai_error',
      'transferred_to_human'
    )
  ),
  category text,
  city text,
  state text,
  timezone text,
  website text,
  google_place_id text,
  google_reviews integer,
  google_rating numeric,
  utm_campaign text,
  business_phone text,
  business_email text,
  owner_name text,
  owner_phone text,
  manager_name text,
  employee_name text,
  ai_summary text,
  conversations integer not null default 0,
  call_attempts integer not null default 0,
  last_call_at timestamptz,
  next_call_at timestamptz,
  resting_until timestamptz,
  retry_counter integer not null default 0,
  retry_position integer not null default 0,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A phone number is unique within a single owner's leads.
  unique (owner_id, business_phone)
);

comment on table public.leads is 'Sales leads — every lead belongs to exactly one list.';

create index leads_owner_id_idx on public.leads (owner_id);
create index leads_list_id_idx on public.leads (list_id);
create index leads_status_idx on public.leads (status);

-- Keep updated_at current on every change.
create function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger leads_set_updated_at
  before update on public.leads
  for each row
  execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Per-lead custom field values.
-- ---------------------------------------------------------------------------
create table public.lead_custom_values (
  lead_id uuid not null references public.leads (id) on delete cascade,
  custom_field_id uuid not null
    references public.custom_field_defs (id) on delete cascade,
  value jsonb,
  primary key (lead_id, custom_field_id)
);

comment on table public.lead_custom_values is 'Custom field values for each lead.';

-- ---------------------------------------------------------------------------
-- Row-Level Security: members see their own leads; admins see all.
-- ---------------------------------------------------------------------------
alter table public.leads enable row level security;

create policy "leads_select"
  on public.leads
  for select
  to authenticated
  using (
    owner_id = (select auth.uid()) or public.is_admin((select auth.uid()))
  );

create policy "leads_insert"
  on public.leads
  for insert
  to authenticated
  with check (
    owner_id = (select auth.uid()) or public.is_admin((select auth.uid()))
  );

create policy "leads_update"
  on public.leads
  for update
  to authenticated
  using (
    owner_id = (select auth.uid()) or public.is_admin((select auth.uid()))
  )
  with check (
    owner_id = (select auth.uid()) or public.is_admin((select auth.uid()))
  );

create policy "leads_delete"
  on public.leads
  for delete
  to authenticated
  using (
    owner_id = (select auth.uid()) or public.is_admin((select auth.uid()))
  );

alter table public.lead_custom_values enable row level security;

-- Access to a lead's custom values follows access to the lead itself.
create policy "lead_custom_values_all"
  on public.lead_custom_values
  for all
  to authenticated
  using (
    exists (
      select 1
      from public.leads
      where leads.id = lead_custom_values.lead_id
        and (
          leads.owner_id = (select auth.uid())
          or public.is_admin((select auth.uid()))
        )
    )
  )
  with check (
    exists (
      select 1
      from public.leads
      where leads.id = lead_custom_values.lead_id
        and (
          leads.owner_id = (select auth.uid())
          or public.is_admin((select auth.uid()))
        )
    )
  );
