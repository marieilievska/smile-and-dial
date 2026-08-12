-- Pool-health connect-rate monitor: exclude ai_error from BOTH the connected
-- count and the total denominator.
--
-- ai_error = OUR ElevenLabs quota/credit failure, not a real call. The monitor
-- counted it as a "connect" (it wasn't in the non-connection list) AND kept it
-- in the denominator, so a credit outage (hundreds of ai_error in an hour) made
-- every number's last_connect_rate_24h look artificially HEALTHY — the auto-rest
-- engine was then least likely to flag a number exactly when the platform was
-- broken. Drop ai_error from both sides so an outage neither inflates nor tanks
-- a number's rate (matches the app-side fix in outcomes.ts / numbers-panel).
--
-- Function body is otherwise identical to 20260718160000.

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

    -- "Connected" = anything except the hard non-connection outcomes AND our own
    -- ai_error platform failures (a human/gatekeeper actually picked up).
    select count(*) into v_connected
      from public.calls
     where twilio_number_id = v_number.id
       and direction = 'outbound'
       and created_at >= now() - interval '24 hours'
       and outcome is not null
       and outcome not in ('voicemail', 'no_answer', 'busy', 'failed', 'invalid_number', 'ai_error');

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
