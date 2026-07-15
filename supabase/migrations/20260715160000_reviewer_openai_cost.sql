-- Make the Call Reviewer's OpenAI spend visible on the Costs page.
--
-- The reviewer (two-pass gpt-5.4-mini -> gpt-5.4) records its per-call cost on
-- call_reviews.cost, which the Costs page never reads — it only sums
-- calls.cost_breakdown.openai. So the largest OpenAI cost showed as $0.
--
-- Fix: fold the reviewer cost into the call's cost_breakdown under its own
-- `openai_review` sub-key (kept separate from the summary/transcription
-- `openai`, and SET rather than added so a re-review never double-counts).
-- Both keys feed the single "OpenAI" line, matching pickBreakdown() in
-- lib/analytics/costs.ts, where openai = openai + openai_review.
--
-- This migration: (1) teaches refresh_cost_rollup() to include openai_review in
-- the openai column AND the total; (2) backfills existing done reviews into
-- cost_breakdown.openai_review; (3) rebuilds the whole rollup.

-- 1) rollup function: openai (and total) now include openai_review.
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
    -- openai = call-time openai + async reviewer openai_review.
    sum(
      public.j_num(c.cost_breakdown, 'openai')
      + public.j_num(c.cost_breakdown, 'openai_review')
    ),
    sum(public.j_num(c.cost_breakdown, 'lookup')),
    sum(
      case
        when (
          public.j_num(c.cost_breakdown, 'twilio')
          + public.j_num(c.cost_breakdown, 'elevenlabs')
          + public.j_num(c.cost_breakdown, 'openai')
          + public.j_num(c.cost_breakdown, 'openai_review')
          + public.j_num(c.cost_breakdown, 'lookup')
        ) > 0
        then (
          public.j_num(c.cost_breakdown, 'twilio')
          + public.j_num(c.cost_breakdown, 'elevenlabs')
          + public.j_num(c.cost_breakdown, 'openai')
          + public.j_num(c.cost_breakdown, 'openai_review')
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

-- 2) backfill: fold each done review's recorded cost into its call's
--    cost_breakdown.openai_review, and recompute the stored total to include
--    it. Idempotent — both keys are SET (jsonb_set), so re-running writes the
--    same values. Only rows with a positive review cost are touched. Uses the
--    ORIGINAL component values (not the just-set keys) plus cr.cost for total.
update public.calls c
set cost_breakdown = jsonb_set(
  jsonb_set(
    coalesce(c.cost_breakdown, '{}'::jsonb),
    '{openai_review}',
    to_jsonb(round(cr.cost::numeric, 4))
  ),
  '{total}',
  to_jsonb(round((
    public.j_num(coalesce(c.cost_breakdown, '{}'::jsonb), 'twilio')
    + public.j_num(coalesce(c.cost_breakdown, '{}'::jsonb), 'elevenlabs')
    + public.j_num(coalesce(c.cost_breakdown, '{}'::jsonb), 'openai')
    + cr.cost
    + public.j_num(coalesce(c.cost_breakdown, '{}'::jsonb), 'lookup')
  )::numeric, 4))
)
from public.call_reviews cr
where cr.call_id = c.id
  and cr.cost is not null
  and cr.cost > 0;

-- 3) rebuild the whole rollup so every ET day reflects the new openai + total.
select public.refresh_cost_rollup(null);
