-- Spend-cap monitor: Eastern day/month, the real per-call cost, auto-resume.
--
-- monitor_campaign_spend_caps() (20260525240000, scheduled every 5 min by
-- 20260811200000) had three defects:
--
--   1. It summed spend "today" from UTC midnight while pre_call_check, the
--      Costs page and every other surface use the Eastern calendar day — so a
--      daily cap reset at 8 PM ET, four hours into the evening calling block.
--   2. It read the STORED cost_breakdown.total, which was stale on ~1,200
--      calls (see 20260905183000). It now uses call_cost_total(), the same
--      definition the rollup and the app use.
--   3. A campaign it paused with paused_reason = 'daily_spend_cap' or
--      'monthly_spend_cap' stayed paused FOREVER unless someone noticed —
--      although the product guide promised it "resumes the next day". It now
--      auto-resumes: daily-cap pauses at the next ET midnight, monthly-cap
--      pauses at the next ET month start — only when the campaign is still
--      under its caps in the new window — and notifies the owner
--      ('campaign_auto_resumed'). Pauses with any OTHER reason (manual,
--      low_credits, auto) are never touched.
--
-- Returns the number of campaigns paused this run (unchanged contract).
-- The dial-time guard (pre_call_check) is deliberately left as is: it already
-- measures the Eastern window, and the backfill + withRecomputedTotal() make
-- the stored total it reads correct going forward.
--
-- NOTE: the in-app resume (resumeCampaign) also re-applies the agent's
-- ElevenLabs webhooks; a SQL resume cannot. The webhooks are per-agent and
-- survive a pause, so this only matters if they were changed while paused —
-- the next manual resume or agent save re-applies them.

create or replace function public.monitor_campaign_spend_caps()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_paused integer := 0;
  v_campaign record;
  v_spend_today numeric;
  v_spend_month numeric;
  v_reason text;
  v_label text;
  -- Eastern calendar-day / month starts, as timestamptz.
  v_day_start timestamptz :=
    date_trunc('day', now() at time zone 'America/New_York')
      at time zone 'America/New_York';
  v_month_start timestamptz :=
    date_trunc('month', now() at time zone 'America/New_York')
      at time zone 'America/New_York';
  v_window_start timestamptz;
begin
  -- ---------------------------------------------------------------------
  -- 1. Auto-resume campaigns whose cap window has rolled over.
  -- ---------------------------------------------------------------------
  for v_campaign in
    select id, owner_id, name, paused_at, paused_reason,
           daily_spend_cap, monthly_spend_cap
      from public.campaigns
     where status = 'paused'
       and paused_reason in ('daily_spend_cap', 'monthly_spend_cap')
  loop
    v_window_start := case v_campaign.paused_reason
      when 'daily_spend_cap' then v_day_start
      else v_month_start
    end;

    -- Still inside the window it was paused in: stay paused.
    if coalesce(v_campaign.paused_at, now()) >= v_window_start then
      continue;
    end if;

    -- A new window. Resume only if the campaign is under BOTH caps in it.
    select coalesce(sum(public.call_cost_total(cost_breakdown)), 0)
      into v_spend_today
      from public.calls
     where campaign_id = v_campaign.id
       and created_at >= v_day_start;
    select coalesce(sum(public.call_cost_total(cost_breakdown)), 0)
      into v_spend_month
      from public.calls
     where campaign_id = v_campaign.id
       and created_at >= v_month_start;

    if (v_campaign.daily_spend_cap is not null
        and v_spend_today >= v_campaign.daily_spend_cap)
    or (v_campaign.monthly_spend_cap is not null
        and v_spend_month >= v_campaign.monthly_spend_cap) then
      continue;
    end if;

    update public.campaigns
       set status = 'active',
           paused_at = null,
           paused_reason = null
     where id = v_campaign.id
       and status = 'paused'
       and paused_reason = v_campaign.paused_reason;

    if found then
      insert into public.notifications (
        user_id, kind, message, ref_table, ref_id
      )
      values (
        v_campaign.owner_id,
        'campaign_auto_resumed',
        format(
          'Campaign "%s" resumed automatically — its %s window has reset.',
          v_campaign.name,
          case v_campaign.paused_reason
            when 'daily_spend_cap' then 'daily spend cap'
            else 'monthly spend cap'
          end
        ),
        'campaigns',
        v_campaign.id
      );
    end if;
  end loop;

  -- ---------------------------------------------------------------------
  -- 2. Pause active campaigns that have hit a cap (Eastern windows).
  -- ---------------------------------------------------------------------
  for v_campaign in
    select id, owner_id, name, daily_spend_cap, monthly_spend_cap
      from public.campaigns
     where status = 'active'
       and (daily_spend_cap is not null or monthly_spend_cap is not null)
  loop
    v_reason := null;
    v_label := null;

    -- Today's spend (Eastern calendar day).
    if v_campaign.daily_spend_cap is not null then
      select coalesce(sum(public.call_cost_total(cost_breakdown)), 0)
        into v_spend_today
        from public.calls
       where campaign_id = v_campaign.id
         and created_at >= v_day_start;
      if v_spend_today >= v_campaign.daily_spend_cap then
        v_reason := 'daily_spend_cap';
        v_label := 'daily spend cap';
      end if;
    end if;

    -- Month's spend (Eastern calendar month). Daily cap wins if both hit.
    if v_reason is null and v_campaign.monthly_spend_cap is not null then
      select coalesce(sum(public.call_cost_total(cost_breakdown)), 0)
        into v_spend_month
        from public.calls
       where campaign_id = v_campaign.id
         and created_at >= v_month_start;
      if v_spend_month >= v_campaign.monthly_spend_cap then
        v_reason := 'monthly_spend_cap';
        v_label := 'monthly spend cap';
      end if;
    end if;

    if v_reason is not null then
      update public.campaigns
         set status = 'paused',
             paused_at = now(),
             paused_reason = v_reason
       where id = v_campaign.id;

      insert into public.notifications (
        user_id, kind, message, ref_table, ref_id
      )
      values (
        v_campaign.owner_id,
        'campaign_auto_paused',
        format(
          'Campaign "%s" was auto-paused because the %s was hit. It will resume automatically when the %s resets.',
          v_campaign.name, v_label,
          case v_reason when 'daily_spend_cap' then 'day' else 'month' end
        ),
        'campaigns',
        v_campaign.id
      );

      v_paused := v_paused + 1;
    end if;
  end loop;

  return v_paused;
end;
$$;

comment on function public.monitor_campaign_spend_caps is
  'Spend cap monitor (Eastern windows). Auto-resumes campaigns it paused '
  'once their day/month resets and they are under cap; then iterates active '
  'campaigns with caps, sums their ET day/month spend via call_cost_total(), '
  'auto-pauses when a cap is hit, and notifies the owner. Returns the number '
  'of campaigns paused this run.';
