-- Twilio number connect-rate monitor (Step 26 / BUILD_PLAN §17 line 1061
-- and §17 line 853-854).
--
-- For each Twilio number we own that's been used for outbound calls today,
-- compute "connect rate" = calls whose outcome is NOT in
-- [voicemail, no_answer, busy, failed, invalid_number] divided by total
-- outbound calls. When the rate is below 15% AND total calls today reach
-- 300+, flag the number for rotation and notify admins.
--
-- The last_connect_rate_check_at / last_calls_count_24h /
-- last_connect_rate_24h columns get updated on every run regardless of
-- whether we flag, so the Twilio Numbers page can show the current numbers
-- to admins. The notification only fires on the false→true transition so
-- we don't spam the admins' inbox every nightly run.

create or replace function public.monitor_twilio_connect_rates()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_flagged integer := 0;
  v_number record;
  v_total integer;
  v_connected integer;
  v_rate numeric;
begin
  for v_number in
    select id, phone_number, flagged_for_rotation
      from public.twilio_numbers
     where released_at is null
  loop
    -- Today's total outbound calls through this number.
    select count(*)
      into v_total
      from public.calls
     where twilio_number_id = v_number.id
       and direction = 'outbound'
       and created_at >= date_trunc('day', now());

    -- Skip the rate math entirely for numbers with no calls today.
    if v_total = 0 then
      update public.twilio_numbers
         set last_connect_rate_check_at = now(),
             last_calls_count_24h = 0,
             last_connect_rate_24h = null
       where id = v_number.id;
      continue;
    end if;

    -- Connected = anything except the non-connection failure modes.
    select count(*)
      into v_connected
      from public.calls
     where twilio_number_id = v_number.id
       and direction = 'outbound'
       and created_at >= date_trunc('day', now())
       and outcome is not null
       and outcome not in (
         'voicemail', 'no_answer', 'busy', 'failed', 'invalid_number'
       );

    v_rate := v_connected::numeric / v_total::numeric;

    update public.twilio_numbers
       set last_connect_rate_check_at = now(),
           last_calls_count_24h = v_total,
           last_connect_rate_24h = v_rate
     where id = v_number.id;

    -- Flag + notify only on transition false → true.
    if v_total >= 300
       and v_rate < 0.15
       and not v_number.flagged_for_rotation then
      update public.twilio_numbers
         set flagged_for_rotation = true
       where id = v_number.id;

      insert into public.notifications (
        user_id, kind, message, ref_table, ref_id
      )
      select p.id,
             'twilio_number_flagged',
             format(
               'Number %s flagged for rotation: %s%% connect rate over %s calls today.',
               v_number.phone_number,
               round(v_rate * 100, 1),
               v_total
             ),
             'twilio_numbers',
             v_number.id
        from public.profiles p
       where p.role = 'admin';

      v_flagged := v_flagged + 1;
    end if;
  end loop;

  return v_flagged;
end;
$$;

comment on function public.monitor_twilio_connect_rates is
  'Nightly job. Updates last_connect_rate_24h / last_calls_count_24h on '
  'every Twilio number, and flags numbers with <15% connect rate over '
  '300+ calls today. Notifies all admins on the false→true flag transition. '
  'Returns the number of newly-flagged numbers.';

grant execute on function public.monitor_twilio_connect_rates() to authenticated;
