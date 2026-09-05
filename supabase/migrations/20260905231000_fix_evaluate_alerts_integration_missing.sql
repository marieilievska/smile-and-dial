-- Fix for evaluate_alerts(): rule h (integration_missing) called btrim() on
-- campaigns.calendly_event_id, which is a uuid, so the rule errored on every
-- run ("function btrim(uuid) does not exist"). The function body below is the
-- 20260905201000 definition with that one expression corrected.

create or replace function public.evaluate_alerts()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  -- Ref for account-wide rules that have no natural row to point at.
  v_global constant uuid := '00000000-0000-0000-0000-000000000000';
  v_et_midnight timestamptz :=
    date_trunc('day', now() at time zone 'America/New_York')
      at time zone 'America/New_York';
  v_fired jsonb := '{}'::jsonb;
  v_errors jsonb := '{}'::jsonb;
  v_n integer;
  v_c record;
  v_j record;
  v_u record;
  v_hb record;
  v_sig record;
  v_last record;
  v_pool record;
  v_credit record;
  v_reason text;
  v_hint text;
  v_minutes integer;
  v_threshold interval;
  v_tools jsonb;
  v_needs_calendly boolean;
  v_needs_close boolean;
  v_missing text[];
  v_pool_fired uuid[] := '{}'::uuid[];
  v_msg text;
begin
  -- -------------------------------------------------------------------------
  -- a. cap_hit_daily — outbound AI calls since ET midnight >= calls_per_day_cap.
  --    Same count pre_call_check uses for 'daily_cap_hit'. Period: the time
  --    since ET midnight, so it fires once per ET day and again tomorrow.
  -- -------------------------------------------------------------------------
  begin
    v_n := 0;
    for v_c in
      select c.id, c.owner_id, c.name, c.calls_per_day_cap,
             (select count(*) from public.calls k
               where k.campaign_id = c.id
                 and k.direction = 'outbound'
                 and k.call_mode = 'ai'
                 and k.status <> 'failed'
                 and k.created_at >= v_et_midnight) as placed
        from public.campaigns c
       where c.status = 'active'
         and c.calls_per_day_cap > 0
    loop
      if v_c.placed >= v_c.calls_per_day_cap
         and public.alert_fire('cap_hit_daily', v_c.id, now() - v_et_midnight)
      then
        insert into public.notifications (user_id, kind, message, ref_table, ref_id)
        values (
          v_c.owner_id,
          'cap_hit_daily',
          format(
            '"%s": Daily call cap reached (%s). Dialing stops until midnight Eastern. Raise the cap in campaign settings if you want more today.',
            v_c.name, to_char(v_c.calls_per_day_cap, 'FM999,999,999')
          ),
          'campaigns', v_c.id
        );
        v_n := v_n + 1;
      end if;
    end loop;
    v_fired := v_fired || jsonb_build_object('cap_hit_daily', v_n);
  exception when others then
    v_errors := v_errors || jsonb_build_object('cap_hit_daily', sqlerrm);
  end;

  -- -------------------------------------------------------------------------
  -- b. cap_hit_hourly — rolling hour >= calls_per_hour_cap. A rhythm, not a
  --    fault: once per 6 hours keeps it quiet.
  -- -------------------------------------------------------------------------
  begin
    v_n := 0;
    for v_c in
      select c.id, c.owner_id, c.name, c.calls_per_hour_cap,
             (select count(*) from public.calls k
               where k.campaign_id = c.id
                 and k.direction = 'outbound'
                 and k.call_mode = 'ai'
                 and k.status <> 'failed'
                 and k.created_at >= now() - interval '1 hour') as placed
        from public.campaigns c
       where c.status = 'active'
         and c.calls_per_hour_cap > 0
    loop
      if v_c.placed >= v_c.calls_per_hour_cap
         and public.alert_fire('cap_hit_hourly', v_c.id, interval '6 hours')
      then
        insert into public.notifications (user_id, kind, message, ref_table, ref_id)
        values (
          v_c.owner_id,
          'cap_hit_hourly',
          format(
            '"%s": Hourly call cap reached (%s). Dialing resumes as the hour rolls over. Raise calls per hour in campaign settings if you want a faster pace.',
            v_c.name, to_char(v_c.calls_per_hour_cap, 'FM999,999,999')
          ),
          'campaigns', v_c.id
        );
        v_n := v_n + 1;
      end if;
    end loop;
    v_fired := v_fired || jsonb_build_object('cap_hit_hourly', v_n);
  exception when others then
    v_errors := v_errors || jsonb_build_object('cap_hit_hourly', sqlerrm);
  end;

  -- -------------------------------------------------------------------------
  -- d. pool_exhausted — every number attached to an active campaign is
  --    rested / flagged / retired / released (or none is attached at all).
  --    Evaluated BEFORE c so the stall rule can defer to this more specific
  --    message for the same campaign in the same run.
  -- -------------------------------------------------------------------------
  begin
    v_n := 0;
    for v_c in
      select c.id, c.owner_id, c.name
        from public.campaigns c
       where c.status = 'active'
         and c.autopilot_enabled
    loop
      select
        count(*) filter (where tn.released_at is null) as attached,
        count(*) filter (where tn.released_at is null
                           and tn.pool_status = 'active'
                           and tn.flagged_for_rotation = false
                           and tn.elevenlabs_phone_number_id is not null
                           and (tn.rested_until is null or tn.rested_until <= now())) as usable,
        count(*) filter (where tn.released_at is null
                           and tn.rested_until is not null
                           and tn.rested_until > now()) as resting,
        count(*) filter (where tn.released_at is null
                           and tn.flagged_for_rotation) as flagged,
        count(*) filter (where tn.released_at is null
                           and tn.pool_status <> 'active') as retired
        into v_pool
        from public.twilio_numbers tn
       where tn.attached_campaign_id = v_c.id;

      if v_pool.usable > 0 then
        continue;
      end if;
      if not public.alert_fire('pool_exhausted', v_c.id, interval '6 hours') then
        v_pool_fired := v_pool_fired || v_c.id;
        continue;
      end if;

      if v_pool.attached = 0 then
        v_msg := format(
          '"%s" has no phone numbers attached, so nothing can dial. Attach a number on Settings → Twilio numbers.',
          v_c.name);
      else
        v_msg := format(
          'All %s number%s on "%s" are out of service right now (%s resting, %s flagged, %s retired). Dialing has stopped until one is usable — wake or replace a number on Settings → Twilio numbers.',
          v_pool.attached, case when v_pool.attached = 1 then '' else 's' end,
          v_c.name, v_pool.resting, v_pool.flagged, v_pool.retired);
      end if;

      insert into public.notifications (user_id, kind, message, ref_table, ref_id)
      values (v_c.owner_id, 'pool_exhausted', v_msg, 'campaigns', v_c.id);
      v_pool_fired := v_pool_fired || v_c.id;
      v_n := v_n + 1;
    end loop;
    v_fired := v_fired || jsonb_build_object('pool_exhausted', v_n);
  exception when others then
    v_errors := v_errors || jsonb_build_object('pool_exhausted', sqlerrm);
  end;

  -- -------------------------------------------------------------------------
  -- c. dialer_stalled — an active autopilot campaign, inside its calling
  --    window (approximated as Eastern time, weekdays; callbacks excluded),
  --    with due cold leads and NO outbound AI call in 15 minutes, while the
  --    heartbeats say either "no tick in > 5 min" or "ticking but blocked by a
  --    fault" (queue read failed / no usable numbers / credits unreadable /
  --    every tick erroring). Caps are NOT faults: a capped campaign keeps
  --    ticking with only cap reasons, and rules a/b own that story.
  -- -------------------------------------------------------------------------
  begin
    v_n := 0;
    select h.ran_at, h.queue_read_failed
      into v_hb
      from public.dialer_heartbeats h
     order by h.ran_at desc
     limit 1;

    -- Fault signals over the last 15 minutes of heartbeats. Empty table (the
    -- app hasn't deployed the heartbeat yet) reads as "unknown", not as a
    -- stall: v_hb.ran_at is null and every bool_or below is null.
    select
      coalesce(bool_or(h.queue_read_failed), false) as queue_failed,
      coalesce(bool_or(jsonb_exists_any(
        coalesce(h.blocked_reasons, '{}'::jsonb),
        array['credit_check_unavailable', 'low_credits']
      )), false) as credits,
      -- distinct: the lateral unnest below repeats a heartbeat row once per
      -- pool-exhausted campaign, so a plain count(*) would over-count ticks.
      (count(distinct h.id) >= 3
        and coalesce(bool_and(h.errors > 0 and h.dialed = 0), false)) as erroring,
      array_agg(distinct pe.campaign_id)
        filter (where pe.campaign_id is not null) as pool_campaigns
      into v_sig
      from public.dialer_heartbeats h
      left join lateral unnest(h.pool_exhausted_campaigns) as pe(campaign_id) on true
     where h.ran_at >= now() - interval '15 minutes';

    for v_c in
      select c.id, c.owner_id, c.name, c.calling_hours_start, c.calling_hours_end
        from public.campaigns c
       where c.status = 'active'
         and c.autopilot_enabled
    loop
      -- Rule d already told this owner about this campaign this run.
      if v_c.id = any(v_pool_fired) then
        continue;
      end if;
      if not public.is_within_calling_hours(
        'America/New_York', v_c.calling_hours_start, v_c.calling_hours_end, false
      ) then
        continue;
      end if;
      if exists (
        select 1 from public.calls k
         where k.campaign_id = v_c.id
           and k.direction = 'outbound'
           and k.call_mode = 'ai'
           and k.created_at >= now() - interval '15 minutes'
      ) then
        continue;
      end if;

      v_reason := null;
      v_hint := null;
      if v_hb.ran_at is not null and v_hb.ran_at < now() - interval '5 minutes' then
        v_reason := 'no_tick';
      elsif v_hb.ran_at is not null then
        if v_sig.queue_failed then
          v_reason := 'queue error';
          v_hint := 'The tick could not read the dial queue — check the dial_queue view and recent migrations.';
        elsif v_c.id = any(coalesce(v_sig.pool_campaigns, '{}'::uuid[])) then
          v_reason := 'no numbers';
          v_hint := 'Every number in the pool is capped or resting — add or wake a number on Settings → Twilio numbers.';
        elsif v_sig.credits then
          v_reason := 'credits';
          v_hint := 'The ElevenLabs credit balance is low or unreadable — check the ElevenLabs account.';
        elsif v_sig.erroring then
          v_reason := 'errors';
          v_hint := 'Every recent tick is erroring without placing a call — check the dialer logs.';
        end if;
      end if;
      if v_reason is null then
        continue;
      end if;

      -- Due cold leads? Skipped when the queue itself is the fault (the tick
      -- already proved it unreadable; asking again here would just hang).
      if v_reason <> 'queue error' and not exists (
        select 1 from public.dial_queue q
         where q.campaign_id = v_c.id
           and q.dial_priority = 1
      ) then
        continue;
      end if;

      if not public.alert_fire('dialer_stalled', v_c.id, interval '2 hours') then
        continue;
      end if;

      if v_reason = 'no_tick' then
        v_msg := format(
          'Dialer stopped: no tick in %s minutes. "%s" has leads due inside calling hours but nothing is being dialed. Check the dialer-tick cron job and the app deployment.',
          floor(extract(epoch from now() - v_hb.ran_at) / 60)::integer, v_c.name);
      else
        v_msg := format(
          'Dialer running but nothing is dialing for "%s" (%s). Leads are due inside calling hours. %s',
          v_c.name, v_reason, v_hint);
      end if;

      insert into public.notifications (user_id, kind, message, ref_table, ref_id)
      values (v_c.owner_id, 'dialer_stalled', v_msg, 'campaigns', v_c.id);
      v_n := v_n + 1;
    end loop;
    v_fired := v_fired || jsonb_build_object('dialer_stalled', v_n);
  exception when others then
    v_errors := v_errors || jsonb_build_object('dialer_stalled', sqlerrm);
  end;

  -- -------------------------------------------------------------------------
  -- e. cron_missed — a pg_cron job whose last run is older than 3x its
  --    interval (daily jobs: 26 h) or whose last run failed. All admins,
  --    once per 6 h per job. Jobs that have never run are skipped: with no
  --    created_at on cron.job there is no way to tell "new" from "stuck".
  --    NOTE: an HTTP job succeeds at the cron level as soon as pg_net queues
  --    the request, so a 401 from the app is NOT a failed run here — that
  --    case surfaces through dialer_stalled ("no tick") instead.
  -- -------------------------------------------------------------------------
  begin
    v_n := 0;
    if exists (select 1 from pg_namespace where nspname = 'cron') then
      for v_j in
        select j.jobid, j.jobname, j.schedule
          from cron.job j
         where j.active
      loop
        select d.status, d.start_time, d.return_message
          into v_last
          from cron.job_run_details d
         where d.jobid = v_j.jobid
         order by d.start_time desc
         limit 1;
        if v_last.start_time is null then
          continue;
        end if;

        v_minutes := public.cron_schedule_minutes(v_j.schedule);
        v_threshold := case
          when v_minutes >= 1440 then interval '26 hours'
          else make_interval(mins => 3 * v_minutes)
        end;

        if v_last.status = 'failed' then
          v_msg := format(
            'Background job "%s" failed its last run%s. Whatever it maintains (dialing, monitors, syncs) is not being kept up — check cron.job_run_details.',
            v_j.jobname,
            case when v_last.return_message is null then ''
                 else ': ' || left(v_last.return_message, 160) end);
        elsif v_last.start_time < now() - v_threshold then
          v_msg := format(
            'Background job "%s" has not run in %s minutes (it is scheduled every %s). Whatever it maintains (dialing, monitors, syncs) has stopped — check pg_cron.',
            v_j.jobname,
            floor(extract(epoch from now() - v_last.start_time) / 60)::integer,
            case when v_minutes >= 1440 then 'day'
                 when v_minutes >= 60 then (v_minutes / 60)::text || ' h'
                 else v_minutes::text || ' min' end);
        else
          continue;
        end if;

        if public.alert_fire('cron_missed', md5(v_j.jobname)::uuid, interval '6 hours') then
          insert into public.notifications (user_id, kind, message, ref_table, ref_id)
          select p.id, 'cron_missed', v_msg, 'cron_job', md5(v_j.jobname)::uuid
            from public.profiles p
           where p.role = 'admin' and p.active;
          v_n := v_n + 1;
        end if;
      end loop;
    end if;
    v_fired := v_fired || jsonb_build_object('cron_missed', v_n);
  exception when others then
    v_errors := v_errors || jsonb_build_object('cron_missed', sqlerrm);
  end;

  -- -------------------------------------------------------------------------
  -- f. placement_storm — >= 20 call_placement_failed events in 10 minutes
  --    for one campaign. Owner, once per hour.
  -- -------------------------------------------------------------------------
  begin
    v_n := 0;
    for v_c in
      select c.id, c.owner_id, c.name, s.failures
        from (
          select (e.payload->>'campaign_id')::uuid as campaign_id, count(*) as failures
            from public.system_events e
           where e.kind = 'call_placement_failed'
             and e.created_at >= now() - interval '10 minutes'
             and (e.payload->>'campaign_id') ~ '^[0-9a-f-]{36}$'
           group by 1
          having count(*) >= 20
        ) s
        join public.campaigns c on c.id = s.campaign_id
    loop
      if public.alert_fire('placement_storm', v_c.id, interval '1 hour') then
        insert into public.notifications (user_id, kind, message, ref_table, ref_id)
        values (
          v_c.owner_id,
          'placement_storm',
          format(
            '%s calls failed to place in the last 10 minutes on "%s" — ElevenLabs/Twilio rejected them before ringing. Attempts are being burned without reaching anyone; check the number pool and the agent''s phone number in ElevenLabs.',
            v_c.failures, v_c.name),
          'campaigns', v_c.id
        );
        v_n := v_n + 1;
      end if;
    end loop;
    v_fired := v_fired || jsonb_build_object('placement_storm', v_n);
  exception when others then
    v_errors := v_errors || jsonb_build_object('placement_storm', sqlerrm);
  end;

  -- -------------------------------------------------------------------------
  -- g. callbacks_piling_paused — a paused campaign with >= 5 overdue pending
  --    callbacks. Owner, once per day.
  -- -------------------------------------------------------------------------
  begin
    v_n := 0;
    for v_c in
      select c.id, c.owner_id, c.name, count(cb.id) as overdue
        from public.campaigns c
        join public.callbacks cb
          on cb.campaign_id = c.id
         and cb.status = 'pending'
         and cb.scheduled_at < now()
       where c.status = 'paused'
       group by c.id, c.owner_id, c.name
      having count(cb.id) >= 5
    loop
      if public.alert_fire('callbacks_piling_paused', v_c.id, interval '24 hours') then
        insert into public.notifications (user_id, kind, message, ref_table, ref_id)
        values (
          v_c.owner_id,
          'callbacks_piling_paused',
          format(
            '"%s" is paused with %s overdue callbacks waiting — people who asked to be called back. Resume the campaign, or call them from the Callbacks page.',
            v_c.name, v_c.overdue),
          'campaigns', v_c.id
        );
        v_n := v_n + 1;
      end if;
    end loop;
    v_fired := v_fired || jsonb_build_object('callbacks_piling_paused', v_n);
  exception when others then
    v_errors := v_errors || jsonb_build_object('callbacks_piling_paused', sqlerrm);
  end;

  -- -------------------------------------------------------------------------
  -- h. integration_missing — an active campaign that books (agent tool or
  --    campaign booking config) or messages (send_email / send_text) while
  --    the OWNER has no Calendly / Close key. Mirrors
  --    campaignIntegrationRequirements() in src/lib/campaigns/. Owner, daily.
  -- -------------------------------------------------------------------------
  begin
    v_n := 0;
    for v_c in
      select c.id, c.owner_id, c.name, c.calendly_event_id, c.fixed_time_booking,
             a.tools_enabled,
             ui.calendly_api_key, ui.close_api_key
        from public.campaigns c
        left join public.agents a on a.id = c.agent_id
        left join public.user_integrations ui on ui.user_id = c.owner_id
       where c.status = 'active'
    loop
      v_tools := coalesce(v_c.tools_enabled, '{}'::jsonb);
      -- jsonb equality, not a ::boolean cast: a malformed value must read as
      -- "off", not abort the whole rule.
      v_needs_calendly :=
        coalesce(v_tools->'get_available_times' = 'true'::jsonb, false)
        or coalesce(v_tools->'book_appointment' = 'true'::jsonb, false)
        or v_c.calendly_event_id is not null
        or v_c.fixed_time_booking is true;
      v_needs_close :=
        coalesce(v_tools->'send_email' = 'true'::jsonb, false)
        or coalesce(v_tools->'send_text' = 'true'::jsonb, false);

      v_missing := '{}'::text[];
      if v_needs_calendly and nullif(btrim(v_c.calendly_api_key), '') is null then
        v_missing := v_missing || 'Calendly';
      end if;
      if v_needs_close and nullif(btrim(v_c.close_api_key), '') is null then
        v_missing := v_missing || 'Close';
      end if;
      if cardinality(v_missing) = 0 then
        continue;
      end if;

      if public.alert_fire('integration_missing', v_c.id, interval '24 hours') then
        insert into public.notifications (user_id, kind, message, ref_table, ref_id)
        values (
          v_c.owner_id,
          'integration_missing',
          format(
            '"%s" is live but its owner has not connected %s, which this campaign''s agent needs (%s). Those steps will fail on calls until it is connected in Settings → Integrations.',
            v_c.name,
            array_to_string(v_missing, ' and '),
            array_to_string(array_remove(array[
              case when 'Calendly' = any(v_missing) then 'it books appointments' end,
              case when 'Close' = any(v_missing) then 'it sends emails or texts' end
            ], null), '; ')),
          'campaigns', v_c.id
        );
        v_n := v_n + 1;
      end if;
    end loop;
    v_fired := v_fired || jsonb_build_object('integration_missing', v_n);
  exception when others then
    v_errors := v_errors || jsonb_build_object('integration_missing', sqlerrm);
  end;

  -- -------------------------------------------------------------------------
  -- i. meta_sync_failed — the nightly Meta audience sync recorded an error
  --    on its most recent run (within 26 h). That user, once per day.
  -- -------------------------------------------------------------------------
  begin
    v_n := 0;
    for v_u in
      select ui.user_id, ui.meta_last_sync_error
        from public.user_integrations ui
       where ui.meta_last_sync_error is not null
         and ui.meta_last_sync_at > now() - interval '26 hours'
    loop
      if public.alert_fire('meta_sync_failed', v_u.user_id, interval '24 hours') then
        insert into public.notifications (user_id, kind, message, ref_table, ref_id)
        values (
          v_u.user_id,
          'meta_sync_failed',
          format(
            'Meta audience sync failed on its last run: %s. Your ad audience is not being updated — reconnect Meta in Settings → Integrations.',
            left(v_u.meta_last_sync_error, 160)),
          'profiles', v_u.user_id
        );
        v_n := v_n + 1;
      end if;
    end loop;
    v_fired := v_fired || jsonb_build_object('meta_sync_failed', v_n);
  exception when others then
    v_errors := v_errors || jsonb_build_object('meta_sync_failed', sqlerrm);
  end;

  -- -------------------------------------------------------------------------
  -- j. credit_read_failed — the credit guard's read of the ElevenLabs balance
  --    has been failing (read_error_logged_at is set on failure and cleared
  --    by the next good read) and the last good reading is older than the
  --    15-minute freshness window, so the tick returns
  --    credit_check_unavailable and dials nothing. All admins, once per 2 h.
  -- -------------------------------------------------------------------------
  begin
    v_n := 0;
    select s.read_error_logged_at, s.checked_at
      into v_credit
      from public.elevenlabs_credit_status s
     where s.id = 1;
    if v_credit.read_error_logged_at is not null
       and (v_credit.checked_at is null
            or v_credit.checked_at < now() - interval '15 minutes')
       and public.alert_fire('credit_read_failed', v_global, interval '2 hours')
    then
      insert into public.notifications (user_id, kind, message, ref_table, ref_id)
      select p.id,
             'credit_read_failed',
             format(
               'The dialer cannot read the ElevenLabs credit balance (%s). Auto-dialing is on hold until a reading succeeds — check the ElevenLabs API key and status page.',
               case when v_credit.checked_at is null then 'no successful reading yet'
                    else 'last good reading ' ||
                         floor(extract(epoch from now() - v_credit.checked_at) / 60)::integer ||
                         ' minutes ago' end),
             'elevenlabs_credit_status', v_global
        from public.profiles p
       where p.role = 'admin' and p.active;
      v_n := 1;
    end if;
    v_fired := v_fired || jsonb_build_object('credit_read_failed', v_n);
  exception when others then
    v_errors := v_errors || jsonb_build_object('credit_read_failed', sqlerrm);
  end;

  return jsonb_build_object('fired', v_fired, 'errors', v_errors, 'at', now());
end;
$$;
