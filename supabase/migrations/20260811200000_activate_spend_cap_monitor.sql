-- Activate the spend-cap monitor cron.
--
-- monitor_campaign_spend_caps() (20260525240000) auto-pauses a campaign that
-- hits its daily/monthly spend cap and notifies the owner — but its cron
-- (20260525250000) was left commented out "until going live", and never got
-- turned on when the dialer went live. So a capped campaign that hit its cap
-- was blocked at dial time (pre_call_check) but stayed status='active', dialed
-- nothing, and never told the owner why. This schedules it (every 5 min),
-- matching how the number-pool health monitor was activated.
--
-- Safe to turn on now: it only acts on campaigns with a cap SET; campaigns with
-- null caps (all current ones) are untouched. Idempotent — unschedules any
-- prior job of the same name first.
--
-- NOTE: monitor_campaign_spend_caps() measures the daily window with
-- date_trunc('day', now()) (UTC), while the rest of the app uses Eastern day
-- boundaries — so the daily cap resets at UTC midnight, a few hours off from the
-- ET day. Acceptable for a coarse daily spend guard; revisit if precise ET
-- alignment is needed.

create extension if not exists pg_cron;

do $$
begin
  perform cron.unschedule('spend-cap-monitor-5m');
exception
  when others then null; -- not scheduled yet
end
$$;

select cron.schedule(
  'spend-cap-monitor-5m',
  '*/5 * * * *',
  $$ select public.monitor_campaign_spend_caps(); $$
);
