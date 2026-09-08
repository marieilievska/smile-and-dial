-- Campaign scoping for cohort_rows, so the Reporting > Daily tab can put a
-- day's calls beside the registrations and spend THAT campaign produced.
--
-- The bug this fixes. The Daily tab joins two per-day sources:
-- reporting_daily_kpis, which takes campaign ids, and cohort_rows, which did
-- not. Narrow the scope picker to one campaign and that campaign's calls sat in
-- the same row as WORKSPACE-WIDE registrations and spend, so every $/reg and
-- $/att on the page was a number divided by the wrong denominator. #498 shipped
-- a guard for it -- the outcome and money columns rendered an em dash under a
-- scope -- which was "do not print a number you know is wrong", not a fix. This
-- is the fix, and that guard goes with it.
--
-- DROP then CREATE, not CREATE OR REPLACE. Adding a parameter changes the
-- function's identity, so a replace would leave the two-argument version in
-- place beside the new one -- an overload, with PostgREST seeing both and
-- picking by the argument names it is handed. A dropped function is a NEW
-- function and takes none of the old one's privileges with it, so the GRANT at
-- the foot of this file is not a formality: without it every signed-in user
-- gets "permission denied for function cohort_rows" instead of a page.
-- tests/function-privileges.unit.test.ts pins that the grant follows the drop.
--
-- Safe to push ahead of the deploy. p_campaign_ids has a default, so the
-- currently deployed two-argument call keeps working unchanged and keeps
-- meaning what it meant.
--
-- ---------------------------------------------------------------------------
-- Null means ALL CAMPAIGNS, everywhere
--
-- The same convention p_campaign follows in list_performance, and the plural
-- uuid[] shape reporting_daily_kpis already uses, so the two halves of a Daily
-- row scope identically and cannot disagree about what "this campaign" means.
-- All three filters read `p_campaign_ids is null or ...`; scoping two of the
-- three would not error, it would just quietly produce a wrong $/reg, which is
-- the whole defect this migration exists to remove.
--
--   call_stats   Calls carry campaign_id directly.
--   spend_stats  cost_rollup_daily.campaign_id is NOT NULL, so scoping it
--                drops nothing that was previously counted.
--   reg_stats    See below -- the subtle one.
--
-- ---------------------------------------------------------------------------
-- A registration inherits its campaign from the calls to its lead
--
-- calendly_events has no campaign of its own. A registration belongs to
-- whichever campaign called the lead, so the filter is an EXISTS over calls,
-- mirroring list_performance's reg_stats exactly rather than inventing a second
-- rule -- two pages attributing a registration to a campaign by different rules
-- is a bug nobody can see.
--
-- DELIBERATE, do not "fix": calendly_events.lead_id is NULLABLE. A registration
-- we could not trace back to a lead has no calls, therefore no campaign, so
-- under a scope the EXISTS is false and the row drops out. That is correct --
-- showing it under a campaign would be an invented number -- and it matches
-- list_performance, which likewise omits its unattributed row whenever a
-- campaign is selected. With no scope (null) nothing is dropped and the totals
-- are exactly what they were before this migration.
--
-- SECURITY INVOKER, stable, and `set search_path = public` all carry over
-- unchanged from 20260905130000. The first is load-bearing: SECURITY DEFINER
-- here would BYPASS RLS and show every member every other member's leads, costs
-- and registrations through a report that looks correctly scoped in the UI.
--
-- The connected-outcome list MUST stay in step with CONNECTED_OUTCOMES in
-- src/lib/calls/outcomes.ts.
drop function if exists public.cohort_rows(date, date);

create function public.cohort_rows(
  p_start date,
  p_end date,
  p_campaign_ids uuid[] default null
)
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
      and (p_campaign_ids is null or c.campaign_id = any(p_campaign_ids))
    group by 1
  ),
  spend_stats as (
    select et_day as d, sum(total) as spend
    from cost_rollup_daily
    where et_day between p_start and p_end
      -- cost_rollup_daily.campaign_id is not null, so this drops nothing.
      and (p_campaign_ids is null or campaign_id = any(p_campaign_ids))
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
      -- A registration has no campaign of its own; it belongs to whoever
      -- called the lead. Same EXISTS as list_performance's reg_stats.
      -- ce.lead_id is nullable, so a registration we could not trace to a lead
      -- has no campaign and drops out under a scope. Deliberate -- see header.
      and (
        p_campaign_ids is null
        or exists (
          select 1
            from calls c2
           where c2.lead_id = ce.lead_id
             and c2.campaign_id = any(p_campaign_ids)
        )
      )
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

comment on function public.cohort_rows(date, date, uuid[]) is
  'Per-dial-day cohort rows: spend and call activity for the day, plus the '
  'registrations it produced and how they turned out, however much later. '
  'p_campaign_ids null means all campaigns; scoped, it filters calls and spend '
  'by campaign_id and registrations by the campaign that called their lead, '
  'the same rule list_performance uses. A registration with no lead cannot be '
  'attributed to a campaign and is omitted under a scope. '
  'SECURITY INVOKER so RLS scopes a member to their own leads.';

-- A dropped function is a new function, so its grant has to be re-issued, and
-- after the DROP rather than before it. The event trigger from 20260906050000
-- has already closed the new function to PUBLIC / anon by the time this runs.
grant execute on function public.cohort_rows(date, date, uuid[]) to authenticated;
