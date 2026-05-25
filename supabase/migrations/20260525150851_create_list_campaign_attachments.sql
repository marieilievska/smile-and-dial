-- list_campaign_attachments: which lists are attached to which campaigns.
-- A list can be attached to at most one *active* campaign at a time; a
-- campaign can have many lists. See BUILD_PLAN.md Sections 3 and 4.

create table public.list_campaign_attachments (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references public.lists (id) on delete cascade,
  campaign_id uuid not null
    references public.campaigns (id) on delete cascade,
  attached_at timestamptz not null default now(),
  detached_at timestamptz
);

comment on table public.list_campaign_attachments is 'Active and historical list-to-campaign assignments.';

create index list_campaign_campaign_idx
  on public.list_campaign_attachments (campaign_id);

-- A list can be attached to only one active campaign at a time. Detached
-- rows stay for history and don't participate in this uniqueness check.
create unique index list_campaign_active_unique
  on public.list_campaign_attachments (list_id)
  where detached_at is null;

-- ---------------------------------------------------------------------------
-- Row-Level Security: access follows access to the parent campaign.
-- ---------------------------------------------------------------------------
alter table public.list_campaign_attachments enable row level security;

create policy "list_campaign_attachments_select"
  on public.list_campaign_attachments
  for select
  to authenticated
  using (
    exists (
      select 1 from public.campaigns
      where campaigns.id = list_campaign_attachments.campaign_id
        and (
          campaigns.owner_id = (select auth.uid())
          or public.is_admin((select auth.uid()))
        )
    )
  );

create policy "list_campaign_attachments_insert"
  on public.list_campaign_attachments
  for insert
  to authenticated
  with check (
    exists (
      select 1 from public.campaigns
      where campaigns.id = list_campaign_attachments.campaign_id
        and (
          campaigns.owner_id = (select auth.uid())
          or public.is_admin((select auth.uid()))
        )
    )
  );

create policy "list_campaign_attachments_update"
  on public.list_campaign_attachments
  for update
  to authenticated
  using (
    exists (
      select 1 from public.campaigns
      where campaigns.id = list_campaign_attachments.campaign_id
        and (
          campaigns.owner_id = (select auth.uid())
          or public.is_admin((select auth.uid()))
        )
    )
  )
  with check (
    exists (
      select 1 from public.campaigns
      where campaigns.id = list_campaign_attachments.campaign_id
        and (
          campaigns.owner_id = (select auth.uid())
          or public.is_admin((select auth.uid()))
        )
    )
  );

create policy "list_campaign_attachments_delete"
  on public.list_campaign_attachments
  for delete
  to authenticated
  using (
    exists (
      select 1 from public.campaigns
      where campaigns.id = list_campaign_attachments.campaign_id
        and (
          campaigns.owner_id = (select auth.uid())
          or public.is_admin((select auth.uid()))
        )
    )
  );
