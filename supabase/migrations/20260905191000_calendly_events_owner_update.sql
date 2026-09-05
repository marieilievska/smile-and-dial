-- Let a registration's owner update it.
--
-- calendly_events had one write policy, calendly_events_admin_write
-- (20260526110000, FOR ALL, admin-only). transitionLeadGoalStatus
-- (src/lib/goals/pipeline-actions.ts) and rescheduleRegistration
-- (src/lib/goals/reschedule-actions.ts) update the registration with the
-- cookie client, so for a member both matched zero rows without an error:
-- attended_at / sale_at never landed and Cohorts counted their attendees as
-- no-shows.
--
-- Fix: an UPDATE policy for the owner. INSERT and DELETE stay admin-only on
-- purpose: rows are created by the Calendly webhook and the booking tool
-- with the service role, and nothing in the app deletes them by hand. The
-- WITH CHECK keeps owner_id pinned so a member can't hand a row to someone
-- else. Admins keep the FOR ALL policy (policies are permissive, so either
-- one passing is enough).

drop policy if exists "calendly_events_owner_update" on public.calendly_events;
create policy "calendly_events_owner_update"
  on public.calendly_events
  for update
  to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
