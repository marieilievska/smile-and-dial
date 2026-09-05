-- One SQL definition of "what a call cost", and a sturdier cost rollup.
--
-- 1. call_cost_components(jsonb) / call_cost_total(jsonb): the SQL twin of
--    pickBreakdown() in lib/costs/breakdown.ts. total = the itemized component
--    sum (twilio + elevenlabs + openai + openai_review + lookup) when the row is
--    itemized, else the stored `total` (legacy rows with an un-itemized total).
--    refresh_cost_rollup(), monitor_campaign_spend_caps() and the stale-total
--    backfill all use it, so no surface can disagree again.
--
-- 2. cost_rollup_daily.goal_leads: count(DISTINCT lead_id) filter (where
--    goal_met). The Costs page counted goal_met CALLS while every other page
--    (Analytics, Today, Reporting, campaign stats) counts distinct businesses —
--    so "Goal Met" and "Cost / Goal Met" disagreed with the rest of the app on
--    any lead that hit the goal twice. `goal_met` (calls) is kept.
--
-- 3. cost_rollup_daily.campaign_id becomes NULLABLE. deleteCampaign detaches
--    calls (`calls.campaign_id` → NULL via `on delete set null`,
--    20260612190000), but the rollup's primary key required campaign_id — so
--    the first detached call inside the cron's 4-day window made
--    refresh_cost_rollup() ABORT on a not-null violation, silently freezing
--    the Costs page. The grain is now enforced by a unique index that
--    coalesces NULL to the all-zero uuid; the page labels those rows
--    "Deleted campaign".

-- 1) helpers -----------------------------------------------------------------
create or replace function public.call_cost_components(j jsonb)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select public.j_num(j, 'twilio')
       + public.j_num(j, 'elevenlabs')
       + public.j_num(j, 'openai')
       + public.j_num(j, 'openai_review')
       + public.j_num(j, 'lookup');
$$;

comment on function public.call_cost_components(jsonb) is
  'Sum of the itemized vendor components of a calls.cost_breakdown. Mirrors '
  'COST_COMPONENT_KEYS in lib/costs/breakdown.ts.';

create or replace function public.call_cost_total(j jsonb)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case
    when public.call_cost_components(j) > 0 then public.call_cost_components(j)
    else public.j_num(j, 'total')
  end;
$$;

comment on function public.call_cost_total(j jsonb) is
  'What a call cost: the itemized component sum, else the stored total for '
  'un-itemized legacy rows. Mirrors breakdownTotal() in lib/costs/breakdown.ts.';

-- 2) + 3) table shape ----------------------------------------------------------
alter table public.cost_rollup_daily
  add column if not exists goal_leads integer not null default 0;

comment on column public.cost_rollup_daily.goal_leads is
  'Distinct leads (businesses) that hit the goal — what every page calls '
  '"Goals met". goal_met is the goal_met CALL count, kept for compatibility.';

alter table public.cost_rollup_daily
  drop constraint if exists cost_rollup_daily_pkey;

alter table public.cost_rollup_daily
  alter column campaign_id drop not null;

create unique index if not exists cost_rollup_daily_grain_idx
  on public.cost_rollup_daily (
    et_day,
    (coalesce(campaign_id, '00000000-0000-0000-0000-000000000000'::uuid)),
    list_id,
    owner_id
  );

-- The page filters on these; the old PK covered et_day-led lookups.
create index if not exists cost_rollup_daily_et_day_idx
  on public.cost_rollup_daily (et_day);

-- refresh function: goal_leads, call_cost_total, NULL-tolerant campaign_id.
create or replace function public.refresh_cost_rollup(p_days date[] default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_days is null then
    delete from public.cost_rollup_daily;
  else
    delete from public.cost_rollup_daily where et_day = any(p_days);
  end if;

  insert into public.cost_rollup_daily (
    et_day, campaign_id, list_id, owner_id, calls, goal_met, goal_leads,
    twilio, elevenlabs, elevenlabs_llm, elevenlabs_voice, elevenlabs_credits,
    elevenlabs_llm_credits, elevenlabs_voice_credits, openai, lookup, total
  )
  select
    (c.created_at at time zone 'America/New_York')::date,
    c.campaign_id,
    l.list_id,
    l.owner_id,
    count(*),
    count(*) filter (where c.goal_met),
    count(distinct c.lead_id) filter (where c.goal_met),
    sum(public.j_num(c.cost_breakdown, 'twilio')),
    sum(public.j_num(c.cost_breakdown, 'elevenlabs')),
    sum(public.j_num(c.cost_breakdown, 'elevenlabs_llm')),
    sum(public.j_num(c.cost_breakdown, 'elevenlabs_voice')),
    sum(public.j_num(c.cost_breakdown, 'elevenlabs_credits')),
    sum(public.j_num(c.cost_breakdown, 'elevenlabs_llm_credits')),
    sum(public.j_num(c.cost_breakdown, 'elevenlabs_voice_credits')),
    -- openai = call-time openai + async reviewer openai_review.
    sum(
      public.j_num(c.cost_breakdown, 'openai')
      + public.j_num(c.cost_breakdown, 'openai_review')
    ),
    sum(public.j_num(c.cost_breakdown, 'lookup')),
    sum(public.call_cost_total(c.cost_breakdown))
  from public.calls c
  join public.leads l on l.id = c.lead_id
  where p_days is null
     or (c.created_at at time zone 'America/New_York')::date = any(p_days)
  group by 1, 2, 3, 4;
end;
$$;

-- (The full rebuild runs in 20260905183000 after the stale totals are
--  backfilled, so the rollup is built once, from corrected rows.)
