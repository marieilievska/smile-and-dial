-- Single-active-dial guarantee at the DB level (shared-list fast-follow).
-- A partial unique index on calls(lead_id) that permits at most ONE in-flight
-- AI outbound call per lead. This closes the last time-of-check/time-of-use
-- windows the app-level guards only narrow: manual "Call Now" vs the autopilot
-- tick (same-campaign, pre-existing) and cross-campaign manual-vs-tick
-- (shared-list Known limitation 2). Real calls = money + TCPA, so the guarantee
-- lives in the database, not just application code. Complements the atomic
-- claim_lead_for_dial from 20260717120000.
--
-- Scope (deliberate):
--   direction = 'outbound'  -> inbound calls insert status='in_progress'
--                              (inbound-webhook.ts); they are legitimately
--                              concurrent with an outbound dial and must never be
--                              blocked from being logged.
--   call_mode = 'ai'        -> covers the tick + manual "Call Now" (both 'ai').
--                              The human browser-dial path ('human') is left as
--                              the accepted Known limitation 3.
--   status in (active)      -> terminal rows are excluded, so a lead may accrue
--                              any number of finished calls; only one may be live.

-- 1. Reconcile (race-proof safety net): terminalize any pre-existing duplicate
--    active AI-outbound rows so the unique index can build. Keep the row that
--    actually placed a call (twilio_call_sid present), then the newest; fail the
--    rest -- mirrors closeStaleActiveCalls. Guarded + deterministic; a no-op once
--    the manual reconcile (plan Task 1) has cleared everything.
with ranked as (
  select id,
         row_number() over (
           partition by lead_id
           order by (twilio_call_sid is not null) desc, created_at desc, id desc
         ) as rn
    from public.calls
   where direction = 'outbound'
     and call_mode = 'ai'
     and status in ('queued', 'dialing', 'ringing', 'in_progress')
)
update public.calls c
   set status = 'failed',
       outcome = coalesce(c.outcome, 'failed'),
       ended_at = coalesce(c.ended_at, now())
  from ranked r
 where c.id = r.id
   and r.rn > 1;

-- 2. The partial unique index: at most one in-flight AI outbound call per lead.
create unique index if not exists calls_one_active_ai_outbound_dial_per_lead
  on public.calls (lead_id)
  where direction = 'outbound'
    and call_mode = 'ai'
    and status in ('queued', 'dialing', 'ringing', 'in_progress');

comment on index public.calls_one_active_ai_outbound_dial_per_lead is
  'At most one in-flight AI outbound call per lead. DB-level double-dial guard '
  '(money + TCPA); complements claim_lead_for_dial. Excludes inbound (direction) '
  'and human browser-dial (call_mode) by design.';
