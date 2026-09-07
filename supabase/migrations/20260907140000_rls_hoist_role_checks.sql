-- A member cannot open the Leads page. The role check runs once per row.
--
-- ---------------------------------------------------------------------------
-- What was measured
--
-- Signing in as each of the three real accounts and asking each one for a
-- straight `count(*)` of its own tables (2026-09-07, production):
--
--                        leads (84,038)      calls (8,156)
--   admin                       174ms              810ms
--   super_admin               5,426ms              783ms
--   member                    8,165ms  HTTP 500  1,340ms
--
-- The member's Leads page took ~9 seconds, and any exact count over `leads`
-- exceeded the 8-second `authenticated` statement timeout and returned a bare
-- 500. Not a slow page -- an unusable one. Nobody had noticed because nobody
-- had ever signed in as the member: the browser used for the September audit
-- was signed in as `marie@` (admin), the one role the bug spares.
--
-- ---------------------------------------------------------------------------
-- Why the roles differ so much
--
-- Every one of these policies reads
--
--     owner_id = (select auth.uid()) or public.is_admin((select auth.uid()))
--
-- `auth.uid()` is already wrapped in a scalar subquery, which is what makes it
-- an InitPlan evaluated once. `public.is_admin(...)` is not, so it is called
-- per row -- and it is a `security definer` function carrying `set search_path
-- = ''`, which means the planner CANNOT inline it (a function with a SET clause
-- never is). It also delegates to `is_super_admin`, itself `security definer`
-- with a SET clause. So each row costs two real function calls, each running
-- `select exists (select 1 from profiles ...)`.
--
-- That is why the admin was fast and nobody else was: the admin owns all 84,038
-- rows, so `owner_id = auth.uid()` is true and OR short-circuits before the
-- function is ever reached. The member owns none, so the left side is false on
-- every row and the function runs 84,038 times. The super admin owns none
-- either -- it just happens to survive the wait.
--
-- `calls` is worse ordered: there `public.is_admin(...)` is the FIRST operand,
-- so it runs per row for every role including the admin, which is why an
-- 8,156-row count costs 810ms. Extrapolate its 65µs/row to 84,038 rows and you
-- get the leads figure exactly.
--
-- ---------------------------------------------------------------------------
-- The change
--
-- `public.is_admin(X)` becomes `(select public.is_admin(X))`, the same scalar
-- subquery idiom already applied to `auth.uid()` beside it. The function is
-- `stable` and takes no column reference, so its value is constant for the
-- whole statement; wrapping it lets Postgres hoist it into an InitPlan and
-- evaluate it once. For a super admin the predicate then folds to a constant
-- true and the RLS check disappears from the plan entirely.
--
-- NOTHING ELSE CHANGES. Every predicate below is character-for-character the
-- policy it replaces apart from that wrapping -- including `leads_update`,
-- which keeps the `can_manage_users` branch 20260906010000 added to its WITH
-- CHECK so the bulk "Reassign owner" action still passes. This must stay a
-- pure performance change: a mistake here does not make a page slow, it makes
-- one owner's rows visible to another.
--
-- ---------------------------------------------------------------------------
-- Scope, and what is deliberately left alone
--
-- Only `leads`, `calls` and `lead_custom_values`. The same unwrapped pattern
-- appears in roughly 157 places across the schema, but every other table it
-- guards holds under a thousand rows today (campaigns 1, lists 2, agents 1,
-- twilio_numbers 97, dnc_entries 36, callbacks 353, system_events 704) and all
-- of them answered in under half a second for all three roles. Rewriting every
-- policy in the schema to fix a cost nothing is paying would be a large blast
-- radius for no measured gain. The rule to apply when one of those tables grows
-- is written down here rather than applied speculatively:
--
--   In an RLS predicate, wrap ANY function call that does not reference the
--   row -- is_admin, is_super_admin, can_manage_users, auth.uid() -- in
--   `(select ...)`. Without it the call is per row, and a SECURITY DEFINER
--   function with a SET clause cannot be inlined away.

-- ---------------------------------------------------------------------------
-- leads: 84,038 rows, and the table that made this visible.
-- ---------------------------------------------------------------------------
drop policy if exists "leads_select" on public.leads;
create policy "leads_select"
  on public.leads
  for select
  to authenticated
  using (
    owner_id = (select auth.uid())
    or (select public.is_admin((select auth.uid())))
  );

drop policy if exists "leads_insert" on public.leads;
create policy "leads_insert"
  on public.leads
  for insert
  to authenticated
  with check (
    owner_id = (select auth.uid())
    or (select public.is_admin((select auth.uid())))
  );

-- Keeps the WITH CHECK branch from 20260906010000: the admin tier may set a
-- DIFFERENT owner_id on a row it already owns, which is what the bulk
-- "Reassign owner" action needs. A member still cannot give a lead away.
drop policy if exists "leads_update" on public.leads;
create policy "leads_update"
  on public.leads
  for update
  to authenticated
  using (
    owner_id = (select auth.uid())
    or (select public.is_admin((select auth.uid())))
  )
  with check (
    owner_id = (select auth.uid())
    or (select public.is_admin((select auth.uid())))
    or (select public.can_manage_users((select auth.uid())))
  );

drop policy if exists "leads_delete" on public.leads;
create policy "leads_delete"
  on public.leads
  for delete
  to authenticated
  using (
    owner_id = (select auth.uid())
    or (select public.is_admin((select auth.uid())))
  );

-- ---------------------------------------------------------------------------
-- calls: 8,156 rows and growing, and the only one where the function sits
-- FIRST in the OR, so it costs every role rather than just the ones who own
-- nothing. There is no calls_delete policy; that is pre-existing and untouched.
-- ---------------------------------------------------------------------------
drop policy if exists "calls_select" on public.calls;
create policy "calls_select"
  on public.calls
  for select
  to authenticated
  using (
    (select public.is_admin((select auth.uid())))
    or exists (
      select 1 from public.leads l
      where l.id = calls.lead_id
        and l.owner_id = (select auth.uid())
    )
  );

drop policy if exists "calls_insert" on public.calls;
create policy "calls_insert"
  on public.calls
  for insert
  to authenticated
  with check (
    (select public.is_admin((select auth.uid())))
    or exists (
      select 1 from public.leads l
      where l.id = lead_id
        and l.owner_id = (select auth.uid())
    )
  );

drop policy if exists "calls_update" on public.calls;
create policy "calls_update"
  on public.calls
  for update
  to authenticated
  using (
    (select public.is_admin((select auth.uid())))
    or exists (
      select 1 from public.leads l
      where l.id = calls.lead_id
        and l.owner_id = (select auth.uid())
    )
  )
  with check (
    (select public.is_admin((select auth.uid())))
    or exists (
      select 1 from public.leads l
      where l.id = calls.lead_id
        and l.owner_id = (select auth.uid())
    )
  );

-- ---------------------------------------------------------------------------
-- lead_custom_values: access follows access to the lead, so the function sits
-- inside the EXISTS and runs once per lead row that subquery examines.
-- ---------------------------------------------------------------------------
drop policy if exists "lead_custom_values_all" on public.lead_custom_values;
create policy "lead_custom_values_all"
  on public.lead_custom_values
  for all
  to authenticated
  using (
    exists (
      select 1
      from public.leads
      where leads.id = lead_custom_values.lead_id
        and (
          leads.owner_id = (select auth.uid())
          or (select public.is_admin((select auth.uid())))
        )
    )
  )
  with check (
    exists (
      select 1
      from public.leads
      where leads.id = lead_custom_values.lead_id
        and (
          leads.owner_id = (select auth.uid())
          or (select public.is_admin((select auth.uid())))
        )
    )
  );
