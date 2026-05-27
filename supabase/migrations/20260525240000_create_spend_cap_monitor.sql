-- Spend cap monitor (Step 25 / BUILD_PLAN §17 line 1060).
--
-- For every currently-active campaign that has a daily_spend_cap or a
-- monthly_spend_cap configured, sum the relevant slice of cost_breakdown.total
-- across that campaign's calls and auto-pause when the cap is reached.
-- Returns the number of campaigns paused this run.

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
begin
  for v_campaign in
    select id, owner_id, name, daily_spend_cap, monthly_spend_cap
      from public.campaigns
     where status = 'active'
       and (daily_spend_cap is not null or monthly_spend_cap is not null)
  loop
    v_reason := null;
    v_label := null;

    -- Today's spend (calendar day, UTC).
    if v_campaign.daily_spend_cap is not null then
      select coalesce(sum((cost_breakdown->>'total')::numeric), 0)
        into v_spend_today
        from public.calls
       where campaign_id = v_campaign.id
         and created_at >= date_trunc('day', now());
      if v_spend_today >= v_campaign.daily_spend_cap then
        v_reason := 'daily_spend_cap';
        v_label := 'daily spend cap';
      end if;
    end if;

    -- Month's spend (calendar month, UTC). Daily cap wins if both hit.
    if v_reason is null and v_campaign.monthly_spend_cap is not null then
      select coalesce(sum((cost_breakdown->>'total')::numeric), 0)
        into v_spend_month
        from public.calls
       where campaign_id = v_campaign.id
         and created_at >= date_trunc('month', now());
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
          'Campaign "%s" was auto-paused because the %s was hit.',
          v_campaign.name, v_label
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
  'Spend cap monitor. Iterates active campaigns with caps configured, '
  'sums their day/month spend from calls.cost_breakdown.total, auto-pauses '
  'when a cap is hit, and notifies the campaign owner. Returns the number '
  'of campaigns paused this run.';

grant execute on function public.monitor_campaign_spend_caps() to authenticated;
