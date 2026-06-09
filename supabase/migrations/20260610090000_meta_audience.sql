-- Meta (Facebook) Custom Audience integration config + per-lead sync state.

alter table public.app_settings
  add column if not exists meta_ad_account_id text,
  add column if not exists meta_access_token text,
  add column if not exists meta_custom_audience_id text,
  add column if not exists meta_audience_terms_accepted_at timestamptz,
  add column if not exists meta_connected_at timestamptz,
  add column if not exists meta_last_sync_at timestamptz,
  add column if not exists meta_last_sync_count integer not null default 0,
  add column if not exists meta_last_sync_error text,
  add column if not exists meta_sync_secret text;

-- Which leads we've already pushed to Meta, so the sync can compute removals
-- (Meta does not let us read audience members back).
alter table public.leads
  add column if not exists meta_synced_at timestamptz;

create index if not exists leads_meta_synced_at_idx
  on public.leads (meta_synced_at)
  where meta_synced_at is not null;
