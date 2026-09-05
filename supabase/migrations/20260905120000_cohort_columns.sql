-- Cohort reporting: a registration owns its own outcome, and carries the dial
-- day whose spend produced it.
--
-- dial_day is STORED, not derived from created_at: a rescheduled booking is
-- created on the day of the reschedule, so deriving the cohort would silently
-- move a person from the day that paid for them to a day that did not,
-- inflating one day and deflating another.

alter table public.calendly_events
  add column if not exists dial_day date,
  add column if not exists attended_at timestamptz,
  add column if not exists sale_at timestamptz,
  add column if not exists rescheduled_at timestamptz;

comment on column public.calendly_events.dial_day is
  'ET day of the call that produced this booking. Preserved across a reschedule '
  'so the cohort stays with the spend that bought it.';
comment on column public.calendly_events.attended_at is
  'Set from the Goals pipeline when the person is marked attended. Unmarked '
  'once the session has reconciled (24h after it ends) means no-show.';
comment on column public.calendly_events.sale_at is
  'Set from the Goals pipeline when the person is marked as a sale.';
comment on column public.calendly_events.rescheduled_at is
  'Last time this registration was moved to a different session. Churn signal '
  'only -- it does not affect any other calculation.';

create index if not exists calendly_events_dial_day_idx
  on public.calendly_events (dial_day);

-- Backfill: every existing registration was booked DURING its own call, so the
-- creation day is the dial day. Only correct for rows predating this migration.
update public.calendly_events
set dial_day = (created_at at time zone 'America/New_York')::date
where dial_day is null;

-- The goal pipeline gains 'rescheduled'. The constraint lists every allowed
-- status, so the value must be added here or the write is rejected.
alter table public.leads
  drop constraint if exists leads_status_check;

alter table public.leads
  add constraint leads_status_check check (
    status in (
      'ready_to_call', 'callback', 'resting', 'goal_met', 'scheduled',
      'attended', 'no_show', 'rescheduled', 'closed', 'sale', 'dnc',
      'email_replied'
    )
  );
