-- Ledger of Twilio Lookup spend that happens OUTSIDE a call.
--
-- The Costs page derives everything from calls.cost_breakdown, but Twilio
-- Lookups run during lead import (to classify line type) — there's no call to
-- attach them to, so that spend never showed up anywhere. This table records
-- each live import's lookup count + cost so the Costs page can fold it into
-- the "Twilio Lookup" vendor line and the totals.

create table public.lookup_charges (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  lookups integer not null,
  cost numeric not null,
  -- Where the charge came from (e.g. 'import'); leaves room for future
  -- non-call lookup sources without a schema change.
  source text not null default 'import',
  created_at timestamptz not null default now()
);

create index lookup_charges_created_idx on public.lookup_charges (created_at);
create index lookup_charges_owner_idx on public.lookup_charges (owner_id);

alter table public.lookup_charges enable row level security;

-- Admins see every charge (the Costs page is workspace-wide for them); members
-- see their own.
create policy "lookup_charges_select"
  on public.lookup_charges
  for select
  to authenticated
  using (
    public.is_admin((select auth.uid()))
    or owner_id = (select auth.uid())
  );

-- A member can only record a charge under their own id.
create policy "lookup_charges_insert"
  on public.lookup_charges
  for insert
  to authenticated
  with check (owner_id = (select auth.uid()));
