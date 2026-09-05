-- Backfill registration outcomes from the pipeline marks made BEFORE the
-- write-through existed (#446).
--
-- Until that shipped, marking someone attended only set leads.status, which
-- holds current state and carries no date. The dated history lives in the
-- goal_transition rows in system_events, so that is what we read back. Without
-- this, every historical attendance reads as a no-show in cohort reporting:
-- the 9/3 session showed 0 attended and 5 no-shows where the truth was 2 and 2.
--
-- Idempotent: only touches registrations that are still unmarked.

with marked as (
  select
    l.id as lead_id,
    l.status,
    -- When the operator actually moved them. Falls back to the session time
    -- for any lead whose transition event has been pruned.
    (
      select max(se.created_at)
      from public.system_events se
      where se.ref_table = 'leads'
        and se.ref_id = l.id
        and se.kind = 'goal_transition'
        and se.payload ->> 'to' in ('attended', 'sale', 'closed')
    ) as marked_at
  from public.leads l
  where l.status in ('attended', 'sale', 'closed')
),
target as (
  -- The registration the mark belongs to: the most recent session that had
  -- already started and is still unmarked. Mirrors pickRegistrationToMark().
  select distinct on (m.lead_id)
    m.lead_id,
    m.status,
    m.marked_at,
    ce.id as registration_id,
    ce.scheduled_at
  from marked m
  join public.calendly_events ce on ce.lead_id = m.lead_id
  where ce.status <> 'canceled'
    and ce.attended_at is null
    and ce.scheduled_at is not null
    and ce.scheduled_at <= now()
  order by m.lead_id, ce.scheduled_at desc
)
update public.calendly_events ce
set
  attended_at = coalesce(t.marked_at, t.scheduled_at + interval '1 hour'),
  sale_at = case
    when t.status in ('sale', 'closed')
      then coalesce(t.marked_at, t.scheduled_at + interval '1 hour')
    else ce.sale_at
  end
from target t
where ce.id = t.registration_id;
