-- Short links minted at send time by the send_text / send_email tools.
-- Additive only. Rows are written by the tool webhook's service-role client
-- (which bypasses RLS); authenticated users only ever read their own.
--
-- The link carries per-lead parameters (business name, phone, email, place id),
-- so it cannot be pre-baked into a campaign template — one row per lead per
-- campaign per channel, reused on repeat sends so click counts stay together.

create table if not exists public.short_links (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id) on delete cascade,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  campaign_id uuid references public.campaigns (id) on delete set null,
  channel text not null check (channel in ('sms', 'email')),
  -- The provider's short code. Nullable: the API returns short_url reliably but
  -- code is not something we want a send to depend on.
  code text,
  short_url text not null,
  -- The full personalised destination. Compared on the next send: an edited
  -- template produces a different long_url, which mints a fresh code rather
  -- than silently sending the old destination.
  long_url text not null,
  created_at timestamptz not null default now()
);

create index if not exists short_links_lookup_idx
  on public.short_links (lead_id, campaign_id, channel, created_at desc);
create index if not exists short_links_owner_id_idx
  on public.short_links (owner_id, created_at desc);

alter table public.short_links enable row level security;

drop policy if exists "short_links_select" on public.short_links;
create policy "short_links_select"
  on public.short_links
  for select
  to authenticated
  using (
    owner_id = (select auth.uid())
    or public.is_admin((select auth.uid()))
  );
