-- Schedule the Call Reviewer's two workers via pg_cron, mirroring the live
-- dialer-tick job (same stable prod URL + x-dialer-secret pulled from
-- public.app_settings; DIALER_TICK_SECRET in Vercel must match, which it does).
--
-- Both jobs are ACTIVITY-GATED so they never waste a tick (or a dollar) when
-- campaigns are idle — the worker is only invoked when there is real work:
--
--   review-tick (every minute): POSTs only when >=1 call_review is 'pending'.
--     Pending rows are created by the post-call webhook ONLY when a human-
--     reached call completes, so an idle system fires nothing and any backlog
--     still drains the moment calls resume.
--
--   review-discover (hourly): POSTs only when a human-reached call was analyzed
--     in the last 2 hours — i.e. a campaign is actively producing reviewed
--     calls. Otherwise it skips, so no idle-hour OpenAI spend.
--
-- cron.schedule upserts by jobname, so re-applying this migration is safe.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'review-tick',
  '* * * * *',
  $cron$
    do $body$
    begin
      if exists (select 1 from public.call_reviews where status = 'pending') then
        perform net.http_post(
          url := 'https://referrizer-smile-and-dial.vercel.app/api/review/tick',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'x-dialer-secret', coalesce(
              (select dialer_tick_secret from public.app_settings limit 1), ''
            )
          ),
          body := '{}'::jsonb
        );
      end if;
    end
    $body$;
  $cron$
);

select cron.schedule(
  'review-discover',
  '0 * * * *',
  $cron$
    do $body$
    begin
      if exists (
        select 1 from public.call_reviews
        where status = 'done'
          and reached_human
          and analyzed_at >= now() - interval '2 hours'
      ) then
        perform net.http_post(
          url := 'https://referrizer-smile-and-dial.vercel.app/api/review/discover',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'x-dialer-secret', coalesce(
              (select dialer_tick_secret from public.app_settings limit 1), ''
            )
          ),
          body := '{}'::jsonb
        );
      end if;
    end
    $body$;
  $cron$
);
