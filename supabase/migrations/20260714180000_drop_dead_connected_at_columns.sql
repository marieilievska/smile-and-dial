-- Drop the last two dead integration columns from the app_settings singleton.
--
-- After the Settings overview page moved to reading user_integrations (the live
-- per-user source, PR #260), close_connected_at + calendly_connected_at on
-- app_settings have no readers left. Both are NULL in prod. This completes the
-- app_settings integration-column cleanup started in 20260714170000.
alter table public.app_settings
  drop column if exists close_connected_at,
  drop column if exists calendly_connected_at;
