-- Open per-number connect-rate history to the number's owner.
--
-- twilio_number_daily_stats_select (20260727180000) was admin-only because
-- the Twilio numbers page was admin-gated at the time. The pool has since
-- been opened to members (20260831120000: twilio_numbers is owner-or-admin),
-- and both readers -- src/app/(app)/settings/twilio-numbers/page.tsx and
-- src/app/(app)/reporting/numbers-panel.tsx -- use the cookie client, so a
-- member saw their numbers with an empty 14 / 30-day trend.
--
-- Same shape as twilio_numbers: visible when you own the number, or when
-- you're an admin. Writes still happen only through the security-definer
-- refresh function run by pg_cron.

drop policy if exists "twilio_number_daily_stats_select"
  on public.twilio_number_daily_stats;
create policy "twilio_number_daily_stats_select"
  on public.twilio_number_daily_stats
  for select
  to authenticated
  using (
    exists (
      select 1 from public.twilio_numbers n
       where n.id = public.twilio_number_daily_stats.twilio_number_id
         and (
           n.owner_id = (select auth.uid())
           or public.is_admin((select auth.uid()))
         )
    )
  );
