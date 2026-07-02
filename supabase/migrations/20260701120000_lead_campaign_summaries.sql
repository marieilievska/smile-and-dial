-- Per-(lead, campaign) rolling AI summary, so call context is scoped to the
-- campaign instead of bleeding across campaigns. leads.ai_summary stays as a
-- denormalized "latest campaign summary" for the leads list + CSV.
create table if not exists public.lead_campaign_summaries (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id) on delete cascade,
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  ai_summary text,
  updated_at timestamptz not null default now(),
  unique (lead_id, campaign_id)
);

create index if not exists lead_campaign_summaries_lead_id_idx
  on public.lead_campaign_summaries (lead_id);

alter table public.lead_campaign_summaries enable row level security;

-- Owner (or admin) can READ their leads' per-campaign summaries (the lead page
-- reads via the typed RLS client). WRITES go through service-role server actions
-- with an in-code owner/admin check (merger, reset, backfill, manual edit) —
-- matching the convention for other derived tables (hot_lead_dismissals,
-- dashboard_notes). Service-role bypasses RLS, so no write policy is needed.
create policy "read own lead campaign summaries"
  on public.lead_campaign_summaries for select
  to authenticated
  using (
    exists (
      select 1
      from public.leads l
      where l.id = lead_campaign_summaries.lead_id
        and (
          l.owner_id = (select auth.uid())
          or public.is_admin((select auth.uid()))
        )
    )
  );

-- Backfill: seed each lead's existing rolling summary into the campaign of its
-- most recent call, so existing context isn't lost.
insert into public.lead_campaign_summaries (lead_id, campaign_id, ai_summary)
select distinct on (l.id) l.id, c.campaign_id, l.ai_summary
from public.leads l
join public.calls c on c.lead_id = l.id and c.campaign_id is not null
where coalesce(trim(l.ai_summary), '') <> ''
order by l.id, c.started_at desc nulls last
on conflict (lead_id, campaign_id) do nothing;
