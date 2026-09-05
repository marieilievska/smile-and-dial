-- Per-dial-day cohort rows for the Reporting > Cohorts tab.
--
-- SECURITY INVOKER, deliberately. This runs as the CALLER so row-level security
-- applies: an admin sees everything, a member sees only leads they own. A
-- SECURITY DEFINER function here (copying refresh_cost_rollup, the obvious
-- pattern to imitate) would BYPASS RLS and show every member every other
-- member's leads, costs and registrations through a report that looks correctly
-- scoped in the UI.
--
-- The aggregation lives in SQL because PostgREST caps every response at 1000
-- rows; counting 8k+ calls in JavaScript would silently undercount (cf. #218,
-- where Analytics showed ~900 of 1431 leads).
--
-- The connected-outcome list MUST stay in step with CONNECTED_OUTCOMES in
-- src/lib/calls/outcomes.ts.
create or replace function public.cohort_rows(p_start date, p_end date)
returns table (
  dial_day date,
  calls integer,
  connected integer,
  dms integer,
  regs integer,
  attended integer,
  no_show integer,
  rescheduled integer,
  sales integer,
  spend numeric,
  pending integer,
  last_session timestamptz
)
language sql
stable
security invoker
set search_path = public
as $$
  with days as (
    select generate_series(p_start, p_end, interval '1 day')::date as d
  ),
  call_stats as (
    select
      (c.created_at at time zone 'America/New_York')::date as d,
      count(*)::integer as calls,
      count(*) filter (
        where c.outcome in (
          'goal_met', 'callback', 'call_back_later', 'not_interested',
          'gatekeeper', 'gatekeeper_not_interested', 'transferred_to_human',
          'language_barrier', 'hung_up_immediately', 'hung_up_later', 'dnc'
        )
      )::integer as connected,
      count(*) filter (where l.decision_maker_reached)::integer as dms
    from calls c
    join leads l on l.id = c.lead_id
    where (c.created_at at time zone 'America/New_York')::date
          between p_start and p_end
    group by 1
  ),
  spend_stats as (
    select et_day as d, sum(total) as spend
    from cost_rollup_daily
    where et_day between p_start and p_end
    group by 1
  ),
  reg_stats as (
    select
      -- Fall back to the creation day for any registration written before
      -- dial_day existed, or by a path that does not stamp it (the Calendly
      -- webhook, if it is ever subscribed). Without this such a row would
      -- group under NULL and vanish from the report entirely.
      coalesce(
        ce.dial_day,
        (ce.created_at at time zone 'America/New_York')::date
      ) as d,
      count(*) filter (where ce.status <> 'canceled')::integer as regs,
      count(*) filter (where ce.attended_at is not null)::integer as attended,
      count(*) filter (where ce.sale_at is not null)::integer as sales,
      count(*) filter (
        where ce.status <> 'canceled' and ce.rescheduled_at is not null
      )::integer as rescheduled,
      -- A session reconciles 24h after it starts. Unmarked past that = no-show.
      count(*) filter (
        where ce.status <> 'canceled'
          and ce.attended_at is null
          and ce.scheduled_at < now() - interval '24 hours'
      )::integer as no_show,
      -- Still to come: the session has not happened, or has not reconciled yet.
      count(*) filter (
        where ce.status <> 'canceled'
          and ce.attended_at is null
          and ce.scheduled_at >= now() - interval '24 hours'
      )::integer as pending,
      max(ce.scheduled_at) as last_session
    from calendly_events ce
    where coalesce(
            ce.dial_day,
            (ce.created_at at time zone 'America/New_York')::date
          ) between p_start and p_end
    group by 1
  )
  select
    d.d,
    coalesce(cs.calls, 0),
    coalesce(cs.connected, 0),
    coalesce(cs.dms, 0),
    coalesce(rs.regs, 0),
    coalesce(rs.attended, 0),
    coalesce(rs.no_show, 0),
    coalesce(rs.rescheduled, 0),
    coalesce(rs.sales, 0),
    coalesce(ss.spend, 0),
    coalesce(rs.pending, 0),
    rs.last_session
  from days d
  left join call_stats cs on cs.d = d.d
  left join spend_stats ss on ss.d = d.d
  left join reg_stats rs on rs.d = d.d
  order by d.d desc;
$$;

comment on function public.cohort_rows(date, date) is
  'Per-dial-day cohort rows: spend and call activity for the day, plus the '
  'registrations it produced and how they turned out, however much later. '
  'SECURITY INVOKER so RLS scopes a member to their own leads.';

grant execute on function public.cohort_rows(date, date) to authenticated;
