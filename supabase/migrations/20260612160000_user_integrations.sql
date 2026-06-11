-- Move Meta (Facebook) Custom Audience config from workspace-level to per-user.
--
-- Close + Calendly are ALREADY per-user (see 20260602120000_per_user_integrations):
-- each rep connects their own account and the AI acts on behalf of the campaign
-- owner. Meta was the last integration still living on the global app_settings
-- row. We bring it in line: each user connects their OWN ad account + token and
-- their sync pushes only the leads THEY own into their OWN Custom Audience.
--
-- meta_sync_secret intentionally STAYS on app_settings: the sync cron is a single
-- workspace-level job that authenticates once and then iterates the users who
-- have connected Meta. It is not a per-user credential.

alter table public.user_integrations
  add column if not exists meta_ad_account_id text,
  add column if not exists meta_access_token text,
  add column if not exists meta_custom_audience_id text,
  add column if not exists meta_audience_terms_accepted_at timestamptz,
  add column if not exists meta_connected_at timestamptz,
  add column if not exists meta_last_sync_at timestamptz,
  add column if not exists meta_last_sync_count integer not null default 0,
  add column if not exists meta_last_sync_error text;

-- Carry the live workspace Meta connection over to marie@referrizer.com so her
-- audience keeps syncing unchanged. She owns every lead today, so her per-user
-- (own-leads) sync is identical to the old all-leads sync. Her user_integrations
-- row already exists (Calendly was connected there), so this is an UPDATE.
update public.user_integrations ui
set
  meta_ad_account_id = s.meta_ad_account_id,
  meta_access_token = s.meta_access_token,
  meta_custom_audience_id = s.meta_custom_audience_id,
  meta_audience_terms_accepted_at = s.meta_audience_terms_accepted_at,
  meta_connected_at = s.meta_connected_at,
  meta_last_sync_at = s.meta_last_sync_at,
  meta_last_sync_count = s.meta_last_sync_count,
  meta_last_sync_error = s.meta_last_sync_error,
  updated_at = now()
from public.app_settings s
where s.id = 1
  and ui.user_id = (
    select id from public.profiles where email = 'marie@referrizer.com' limit 1
  );

-- Safety net: if marie somehow has no user_integrations row yet, create one
-- carrying just the Meta fields (Calendly/Close stay null until she connects).
insert into public.user_integrations (
  user_id,
  meta_ad_account_id,
  meta_access_token,
  meta_custom_audience_id,
  meta_audience_terms_accepted_at,
  meta_connected_at,
  meta_last_sync_at,
  meta_last_sync_count,
  meta_last_sync_error
)
select
  p.id,
  s.meta_ad_account_id,
  s.meta_access_token,
  s.meta_custom_audience_id,
  s.meta_audience_terms_accepted_at,
  s.meta_connected_at,
  s.meta_last_sync_at,
  s.meta_last_sync_count,
  s.meta_last_sync_error
from public.app_settings s
cross join public.profiles p
where p.email = 'marie@referrizer.com'
  and s.id = 1
on conflict (user_id) do nothing;
