-- Pre-aggregated daily cost rollup.
--
-- The Costs page re-summed the ENTIRE calls history (parsing each row's
-- cost_breakdown JSON) on every visit — several full scans — and got slower
-- every day. This table holds one pre-summed row per ET calendar day ×
-- campaign × list × owner, so the page reads a few hundred small rows instead
-- of scanning tens of thousands of calls. calls.campaign_id and
-- leads.list_id/owner_id are all NOT NULL, so the grain is a clean primary key.
--
-- The SQL below reproduces pickBreakdown() from lib/analytics/costs.ts EXACTLY:
--   * each vendor field = the JSON key iff it is a number, else 0 (j_num);
--   * total = the itemized component sum (twilio+elevenlabs+openai+lookup) when
--     that is > 0, else the stored `total` (legacy rows with an un-itemized
--     total). The elevenlabs_* split keys are sub-parts of `elevenlabs` and are
--     deliberately NOT re-added into total.

-- --- helper: numeric JSON field or 0 (mirrors pickBreakdown's per-key n()). ---
create or replace function public.j_num(j jsonb, k text)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case
    when j is null then 0
    when jsonb_typeof(j -> k) = 'number' then (j ->> k)::numeric
    else 0
  end;
$$;

-- --- the rollup table. ---
create table public.cost_rollup_daily (
  et_day date not null,
  campaign_id uuid not null,
  list_id uuid not null,
  owner_id uuid not null,
  calls integer not null default 0,
  goal_met integer not null default 0,
  twilio numeric not null default 0,
  elevenlabs numeric not null default 0,
  elevenlabs_llm numeric not null default 0,
  elevenlabs_voice numeric not null default 0,
  elevenlabs_credits numeric not null default 0,
  elevenlabs_llm_credits numeric not null default 0,
  elevenlabs_voice_credits numeric not null default 0,
  openai numeric not null default 0,
  lookup numeric not null default 0,
  total numeric not null default 0,
  refreshed_at timestamptz not null default now(),
  primary key (et_day, campaign_id, list_id, owner_id)
);

comment on table public.cost_rollup_daily is
  'Pre-aggregated call spend per ET day x campaign x list x owner. Refreshed by '
  'refresh_cost_rollup() (cron: recent days; backfill: all). Mirrors '
  'pickBreakdown() in lib/analytics/costs.ts.';

-- RLS: a member sees only their own rows; admins see all — matching how
-- calls/leads are scoped. Writes are SECURITY DEFINER / service-role only.
alter table public.cost_rollup_daily enable row level security;

create policy "cost_rollup_daily_select"
  on public.cost_rollup_daily
  for select
  to authenticated
  using (
    owner_id = (select auth.uid()) or public.is_admin((select auth.uid()))
  );

-- --- refresh function: recompute the given ET days (or ALL when null). ---
-- SECURITY DEFINER so the cron (and a full backfill) can aggregate across every
-- owner's calls and write the table regardless of the caller's RLS.
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
    et_day, campaign_id, list_id, owner_id, calls, goal_met,
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
    sum(public.j_num(c.cost_breakdown, 'twilio')),
    sum(public.j_num(c.cost_breakdown, 'elevenlabs')),
    sum(public.j_num(c.cost_breakdown, 'elevenlabs_llm')),
    sum(public.j_num(c.cost_breakdown, 'elevenlabs_voice')),
    sum(public.j_num(c.cost_breakdown, 'elevenlabs_credits')),
    sum(public.j_num(c.cost_breakdown, 'elevenlabs_llm_credits')),
    sum(public.j_num(c.cost_breakdown, 'elevenlabs_voice_credits')),
    sum(public.j_num(c.cost_breakdown, 'openai')),
    sum(public.j_num(c.cost_breakdown, 'lookup')),
    sum(
      case
        when (
          public.j_num(c.cost_breakdown, 'twilio')
          + public.j_num(c.cost_breakdown, 'elevenlabs')
          + public.j_num(c.cost_breakdown, 'openai')
          + public.j_num(c.cost_breakdown, 'lookup')
        ) > 0
        then (
          public.j_num(c.cost_breakdown, 'twilio')
          + public.j_num(c.cost_breakdown, 'elevenlabs')
          + public.j_num(c.cost_breakdown, 'openai')
          + public.j_num(c.cost_breakdown, 'lookup')
        )
        else public.j_num(c.cost_breakdown, 'total')
      end
    )
  from public.calls c
  join public.leads l on l.id = c.lead_id
  where p_days is null
     or (c.created_at at time zone 'America/New_York')::date = any(p_days)
  group by 1, 2, 3, 4;
end;
$$;

-- --- one-time backfill of all history. ---
select public.refresh_cost_rollup(null);

-- --- cron: refresh today + the last 3 ET days every 10 minutes (covers
--     late-arriving webhooks that update a recent call's cost). Older days are
--     immutable once their calls settle. Runs entirely in-DB (no HTTP hop). ---
select cron.schedule(
  'cost-rollup-refresh',
  '*/10 * * * *',
  $cron$
    select public.refresh_cost_rollup(array[
      ((now() at time zone 'America/New_York')::date),
      ((now() at time zone 'America/New_York')::date - 1),
      ((now() at time zone 'America/New_York')::date - 2),
      ((now() at time zone 'America/New_York')::date - 3)
    ])
  $cron$
);
