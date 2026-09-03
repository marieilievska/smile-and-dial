-- One definition of "connected" for the number-pool SQL, matching the app.
--
-- The app's connect rate (Today, Calls, Reporting, Analytics, the Numbers tab)
-- counts a call as connected when its outcome is in CONNECTED_OUTCOMES
-- (src/lib/calls/outcomes.ts): a PERSON picked up. The two number-pool
-- functions instead used "anything except voicemail/no_answer/busy/failed/
-- invalid_number", which counts an AI-receptionist BOT answering
-- (`ai_receptionist`) as a connection — and refresh_twilio_number_daily_stats
-- also counted our own `ai_error` platform failures as connections and kept
-- them in the denominator. So the per-number Connect column, its trend
-- sparkline and the 24h figure disagreed with every other connect rate on the
-- same screen.
--
-- Both functions now use the explicit CONNECTED list, and both keep ai_error
-- out of the connect-rate denominator (an EL credit outage must neither
-- inflate nor tank a number's rate). `calls` in the daily table stays the
-- plain outbound row count — that is what "calls" means everywhere else.
-- Bodies are otherwise identical to 20260811190000 / 20260727180000.
-- KEEP THE LIST IN STEP WITH CONNECTED_OUTCOMES.

create or replace function public.monitor_twilio_connect_rates()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_acted integer := 0;
  v_number record;
  v_total integer;
  v_connected integer;
  v_rate numeric;
  v_settings jsonb;
  v_min_samples int;
  v_abs_floor numeric;
  v_rest_hours int;
begin
  select number_pool_settings into v_settings from public.app_settings limit 1;
  v_min_samples := coalesce((v_settings->>'rest_min_samples')::int, 20);
  v_abs_floor   := coalesce((v_settings->>'rest_abs_floor')::numeric, 0.10);
  v_rest_hours  := coalesce((v_settings->>'rest_hours')::int, 24);

  for v_number in
    select id, phone_number, flagged_for_rotation, pool_status, rested_until
      from public.twilio_numbers
     where released_at is null
  loop
    -- Trailing-24h outbound calls through this number. ai_error excluded: an EL
    -- quota outage is not a real call attempt for connect-rate purposes.
    select count(*) into v_total
      from public.calls
     where twilio_number_id = v_number.id
       and direction = 'outbound'
       and created_at >= now() - interval '24 hours'
       and (outcome is null or outcome <> 'ai_error');

    if v_total = 0 then
      update public.twilio_numbers
         set last_connect_rate_check_at = now(),
             last_calls_count_24h = 0,
             last_connect_rate_24h = null
       where id = v_number.id;
      continue;
    end if;

    -- "Connected" = a person picked up: the app-wide CONNECTED_OUTCOMES list.
    select count(*) into v_connected
      from public.calls
     where twilio_number_id = v_number.id
       and direction = 'outbound'
       and created_at >= now() - interval '24 hours'
       and outcome in (
         'goal_met', 'callback', 'call_back_later', 'not_interested',
         'gatekeeper', 'gatekeeper_not_interested', 'transferred_to_human',
         'language_barrier', 'hung_up_immediately', 'hung_up_later', 'dnc'
       );

    v_rate := v_connected::numeric / v_total::numeric;

    update public.twilio_numbers
       set last_connect_rate_check_at = now(),
           last_calls_count_24h = v_total,
           last_connect_rate_24h = v_rate
     where id = v_number.id;

    -- Act only on ACTIVE numbers with a trustworthy sample.
    if v_number.pool_status = 'active' and v_total >= v_min_samples then
      if v_rate < v_abs_floor / 2.0 and not v_number.flagged_for_rotation then
        update public.twilio_numbers
           set flagged_for_rotation = true
         where id = v_number.id;

        insert into public.notifications (user_id, kind, message, ref_table, ref_id)
        select p.id,
               'twilio_number_flagged',
               format(
                 'Number %s flagged: %s%% connect rate over %s calls (24h) — review or replace.',
                 v_number.phone_number, round(v_rate * 100, 1), v_total
               ),
               'twilio_numbers', v_number.id
          from public.profiles p
         where p.role = 'admin';

        v_acted := v_acted + 1;

      elsif v_rate < v_abs_floor
            and (v_number.rested_until is null or v_number.rested_until <= now()) then
        update public.twilio_numbers
           set rested_until = now() + make_interval(hours => v_rest_hours)
         where id = v_number.id;

        insert into public.system_events (kind, actor_user_id, ref_table, ref_id, payload)
        values ('number_rested', null, 'twilio_numbers', v_number.id,
                jsonb_build_object(
                  'phone_number', v_number.phone_number,
                  'connect_rate', v_rate,
                  'calls_24h', v_total,
                  'rested_hours', v_rest_hours
                ));
        v_acted := v_acted + 1;
      end if;
    end if;
  end loop;

  return v_acted;
end;
$$;

create or replace function public.refresh_twilio_number_daily_stats(
  in_days_back integer default 3
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
  v_from date;
begin
  v_from := (now() at time zone 'America/New_York')::date
              - greatest(0, coalesce(in_days_back, 3));

  insert into public.twilio_number_daily_stats
    (twilio_number_id, day, calls, connected, connect_rate, updated_at)
  select
    c.twilio_number_id,
    (c.created_at at time zone 'America/New_York')::date,
    count(*),
    count(*) filter (
      where c.outcome in (
        'goal_met', 'callback', 'call_back_later', 'not_interested',
        'gatekeeper', 'gatekeeper_not_interested', 'transferred_to_human',
        'language_barrier', 'hung_up_immediately', 'hung_up_later', 'dnc'
      )
    ),
    round(
      count(*) filter (
        where c.outcome in (
          'goal_met', 'callback', 'call_back_later', 'not_interested',
          'gatekeeper', 'gatekeeper_not_interested', 'transferred_to_human',
          'language_barrier', 'hung_up_immediately', 'hung_up_later', 'dnc'
        )
      )::numeric
      / nullif(count(*) filter (where c.outcome is distinct from 'ai_error'), 0),
      4
    ),
    now()
    from public.calls c
   where c.twilio_number_id is not null
     and c.direction = 'outbound'
     and (c.created_at at time zone 'America/New_York')::date >= v_from
   group by 1, 2
  on conflict (twilio_number_id, day) do update
     set calls = excluded.calls,
         connected = excluded.connected,
         connect_rate = excluded.connect_rate,
         updated_at = now();

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

-- Recompute the history under the new definition so the trend doesn't show a
-- step where the rule changed, and refresh the 24h figures right away.
select public.refresh_twilio_number_daily_stats(400);
select public.monitor_twilio_connect_rates();
