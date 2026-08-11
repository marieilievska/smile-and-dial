-- Stop double-booking a lead into the same event slot.
--
-- book_appointment fires twice within one call (the model re-confirms, or
-- ElevenLabs re-delivers a slow tool call). The cancel-based de-dup that used to
-- catch this was removed on 2026-07-31 because cancelling a shared WEBINAR
-- session drops every registrant — so the fix must never cancel. The tool now
-- guards before creating the invitee (src/lib/elevenlabs/tool-webhook.ts); this
-- is the atomic backstop so a concurrent double can't slip a second row through.

-- Collapse existing duplicate SCHEDULED rows, keeping the earliest per
-- (lead, event type, slot). This removes duplicate DB RECORDS only — it does NOT
-- cancel any Calendly invitee (those are handled separately).
delete from public.calendly_events a
using public.calendly_events b
where a.status = 'scheduled'
  and b.status = 'scheduled'
  and a.lead_id = b.lead_id
  and a.event_type_uri is not distinct from b.event_type_uri
  and a.scheduled_at is not distinct from b.scheduled_at
  and a.ctid > b.ctid;

-- One live registration per lead per event slot.
create unique index if not exists calendly_events_one_scheduled_per_slot
  on public.calendly_events (lead_id, event_type_uri, scheduled_at)
  where status = 'scheduled';
