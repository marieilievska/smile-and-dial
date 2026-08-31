-- Open the Twilio number pool to members (owner-scoped).
--
-- The numbers *page* and src/lib/twilio/number-actions.ts were already written
-- for member self-service ("Members (builders) manage the number pool; only
-- permanent delete is admin-only"), but twilio_numbers RLS stayed admin-only and
-- pool-actions.ts still required admin. This finishes the feature, mirroring
-- 20260525142147 (which opened agents + campaigns to the owner-or-admin pattern).
--
-- ElevenLabs / Twilio stay ONE shared account (server env). "Their own numbers"
-- means each member buys on the same Twilio account into their OWN campaigns and
-- sees/manages only their own rows; admins still see everything.

-- ---------------------------------------------------------------------------
-- 1) Ownership column.
--    Nullable on purpose: existing rows and admin-synced/orphan numbers stay
--    valid, and a null owner is visible to admins only (null <> any auth.uid()).
--    New member buys stamp owner_id in code. on delete set null so removing a
--    profile never cascade-deletes a live phone number.
-- ---------------------------------------------------------------------------
alter table public.twilio_numbers
  add column if not exists owner_id uuid references public.profiles (id) on delete set null;

comment on column public.twilio_numbers.owner_id is
  'The member (or admin) who owns this number. Null = legacy/orphan, admin-only. '
  'RLS scopes visibility/management to the owner; the dialer picks from-numbers '
  'by attached_campaign_id on the service role, so ownership never affects dialing.';

-- Backfill every current number to the sole owner today. She owns all
-- campaigns/leads, so this matches how the pool is already used.
update public.twilio_numbers
set owner_id = (
  select id from public.profiles where email = 'marie@referrizer.com' limit 1
)
where owner_id is null;

create index if not exists twilio_numbers_owner_id_idx
  on public.twilio_numbers (owner_id);

-- ---------------------------------------------------------------------------
-- 2) RLS: admin-only -> owner-or-admin (identical shape to agents/campaigns).
-- ---------------------------------------------------------------------------
drop policy if exists "twilio_numbers_select" on public.twilio_numbers;
drop policy if exists "twilio_numbers_insert" on public.twilio_numbers;
drop policy if exists "twilio_numbers_update" on public.twilio_numbers;
drop policy if exists "twilio_numbers_delete" on public.twilio_numbers;

create policy "twilio_numbers_select"
  on public.twilio_numbers
  for select
  to authenticated
  using (
    owner_id = (select auth.uid()) or public.is_admin((select auth.uid()))
  );

create policy "twilio_numbers_insert"
  on public.twilio_numbers
  for insert
  to authenticated
  with check (
    owner_id = (select auth.uid()) or public.is_admin((select auth.uid()))
  );

create policy "twilio_numbers_update"
  on public.twilio_numbers
  for update
  to authenticated
  using (
    owner_id = (select auth.uid()) or public.is_admin((select auth.uid()))
  )
  with check (
    owner_id = (select auth.uid()) or public.is_admin((select auth.uid()))
  );

create policy "twilio_numbers_delete"
  on public.twilio_numbers
  for delete
  to authenticated
  using (
    owner_id = (select auth.uid()) or public.is_admin((select auth.uid()))
  );
