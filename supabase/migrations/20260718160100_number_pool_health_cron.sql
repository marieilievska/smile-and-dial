-- Activate the pool health monitor (it was intentionally dormant, see
-- 20260525270000_connect_rate_monitor_cron_schedule.sql). Runs every 30 minutes
-- so a cratering number is rested within half an hour. The function is pure SQL,
-- so the cron calls it directly (no HTTP). cron.schedule upserts by jobname, so
-- re-applying this migration is safe.
create extension if not exists pg_cron;

select cron.schedule(
  'twilio-connect-rate-monitor',
  '*/30 * * * *',
  $$ select public.monitor_twilio_connect_rates(); $$
);
