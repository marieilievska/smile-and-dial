-- Drop superseded integration columns from the app_settings singleton.
--
-- Close / Calendly / Meta integrations moved to the per-user user_integrations
-- table long ago; these app_settings copies are dead. Verified: nothing in code
-- reads any of them (every app_settings query selects only agent_analytics_share_token,
-- best_time_heatmap*, the elevenlabs_* webhook secrets, meta_sync_secret, or
-- close_connected_at/calendly_connected_at). In prod all 14 are NULL except
-- meta_last_sync_count (a stale integer) — so no credential or real data is lost.
--
-- KEPT (still used): close_connected_at + calendly_connected_at (read by the
-- settings overview page) and meta_sync_secret (the Meta cron secret).
--
-- The dropped columns remain in database.types.ts until the next
-- `supabase gen types` regen — harmless, since nothing selects them.

alter table public.app_settings
  drop column if exists calendly_access_token,
  drop column if exists calendly_refresh_token,
  drop column if exists calendly_organization_uri,
  drop column if exists calendly_user_uri,
  drop column if exists calendly_last_sync_at,
  drop column if exists close_api_key,
  drop column if exists meta_ad_account_id,
  drop column if exists meta_access_token,
  drop column if exists meta_custom_audience_id,
  drop column if exists meta_audience_terms_accepted_at,
  drop column if exists meta_connected_at,
  drop column if exists meta_last_sync_at,
  drop column if exists meta_last_sync_count,
  drop column if exists meta_last_sync_error;
