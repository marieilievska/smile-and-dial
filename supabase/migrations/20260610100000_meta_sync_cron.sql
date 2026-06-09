-- Nightly Meta Custom Audience sync. pg_cron + pg_net (already enabled by the
-- dialer cron migration). Reads the sync secret from app_settings; until the
-- integration is connected (secret null), the endpoint rejects the call — so
-- this is dormant and safe until the user connects Meta in Settings.

select cron.unschedule(jobid)
from cron.job
where jobname = 'meta-audience-sync';

select cron.schedule(
  'meta-audience-sync',
  '0 8 * * *',
  $cmd$
  select net.http_post(
    url := 'https://referrizer-smile-and-dial.vercel.app/api/meta/sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-meta-sync-secret', coalesce(
        (select meta_sync_secret from public.app_settings limit 1), ''
      )
    ),
    body := '{}'::jsonb
  );
  $cmd$
);
