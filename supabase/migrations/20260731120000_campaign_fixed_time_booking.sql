-- A per-campaign "fixed-time event" flag for booking.
--
-- book_appointment normally needs a slot_id — the ISO start time the lead chose
-- from get_available_times. For a fixed-time event (a webinar: one known
-- session everyone registers into) that discovery step is pointless friction,
-- and the agent's prompt reasonably tells it to book with just name + email. So
-- when this flag is true, the webhook resolves the campaign's Calendly event's
-- next opening itself and books that, ignoring slot_id.
--
-- Default false: every existing campaign keeps the current "lead picks a time"
-- behavior, so this is a no-op until an operator turns it on.

alter table public.campaigns
  add column if not exists fixed_time_booking boolean not null default false;

comment on column public.campaigns.fixed_time_booking is
  'When true, book_appointment ignores slot_id and books the campaign''s '
  'Calendly event''s soonest upcoming opening — for fixed-time events '
  '(webinars) where the agent should not offer a choice of times. Requires a '
  'calendly_event_id; false = the normal lead-picks-a-slot flow.';
