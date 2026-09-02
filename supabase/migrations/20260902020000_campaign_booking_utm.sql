-- Per-campaign "Booking UTM campaign".
--
-- Every Calendly booking the agent makes carries a tracking object
-- (utm_source / utm_medium / utm_campaign / utm_content / utm_term). Until now
-- utm_campaign came from a HARDCODED campaign-id -> value map in
-- src/lib/calendly/booking.ts (CAMPAIGN_BOOKING_UTM), which silently stops
-- matching every time a campaign is recreated (a DB reset gives it a new id —
-- it has happened twice). The operator's ask on 2026-09-02 — "put
-- ai_voice_training_daily as the UTM campaign for this campaign only" — is a
-- per-campaign setting, so it becomes one: a nullable column the campaign
-- settings dialog edits and bookAppointment reads at booking time.
--
-- Resolution order at booking time: this column -> the legacy map -> the
-- campaign name. NULL/blank = unchanged behaviour.
--
-- Safe: additive nullable column; no data change.

alter table public.campaigns
  add column if not exists booking_utm_campaign text;

alter table public.campaigns
  drop constraint if exists campaigns_booking_utm_campaign_check;

alter table public.campaigns
  add constraint campaigns_booking_utm_campaign_check
    check (
      booking_utm_campaign is null
      or (
        length(booking_utm_campaign) between 1 and 100
        and booking_utm_campaign ~ '^[a-z0-9_-]+$'
      )
    );

comment on column public.campaigns.booking_utm_campaign is
  'utm_campaign (and utm_content) stamped on every Calendly booking made from this campaign. Lower-case [a-z0-9_-], max 100. NULL = fall back to the legacy id map, then the campaign name.';
