-- Smart Lists R2: cached membership + atomic refresh.
--
-- A smart list (R1) is a saved filter recipe. R2 caches its matching lead ids in
-- smart_list_members so the dialer can read membership cheaply, and refreshes the
-- cache from the recipe via the R1 leads_matching_filter() engine (single source
-- of truth). Membership = presence of a row; refresh_smart_list() full-replaces a
-- list's rows atomically.

create table public.smart_list_members (
  smart_list_id uuid not null
    references public.smart_lists (id) on delete cascade,
  lead_id uuid not null
    references public.leads (id) on delete cascade,
  primary key (smart_list_id, lead_id)
);

create index smart_list_members_lead_idx
  on public.smart_list_members (lead_id);

comment on table public.smart_list_members is
  'Cached membership of each smart list (the lead ids matching its saved '
  'filter). Rewritten by refresh_smart_list() on a few-minute cron and '
  'immediately when a list is attached to a campaign. Read by the dial_queue '
  'view as a third audience branch.';

alter table public.smart_list_members enable row level security;

-- Admin-managed surface, matching smart_lists (smart_lists_admin_all). Admins do
-- everything; the service role bypasses RLS for the cron refresh.
create policy "smart_list_members_admin_all" on public.smart_list_members
  for all to authenticated
  using (public.is_admin((select auth.uid())))
  with check (public.is_admin((select auth.uid())));

grant select, insert, update, delete on public.smart_list_members to authenticated;

-- Atomically rebuild ONE smart list's members from its saved recipe. SECURITY
-- DEFINER so the cron (service role) and an admin "refresh now" both work; runs
-- as owner, can read all leads and write members. Returns the new member count.
create or replace function public.refresh_smart_list(in_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_filter jsonb;
  v_count integer;
begin
  select filter into v_filter from public.smart_lists where id = in_id;
  if v_filter is null then
    -- No such list (or null recipe): clear any stale rows, report zero.
    delete from public.smart_list_members where smart_list_id = in_id;
    return 0;
  end if;

  delete from public.smart_list_members where smart_list_id = in_id;
  insert into public.smart_list_members (smart_list_id, lead_id)
  select in_id, lf
  from public.leads_matching_filter(v_filter) as lf
  on conflict do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

grant execute on function public.refresh_smart_list(uuid) to authenticated, service_role;
