-- BUILD_PLAN Section 5 line 55 grants members access to their own campaigns
-- ("Member — sees and edits only their own leads, calls, callbacks,
-- campaigns"). Members also need to build their own agents — otherwise the
-- campaign agent picker is empty for them. Relax both tables' RLS from
-- admin-only to the owner-or-admin pattern used by lists and goals.

-- ---------------------------------------------------------------------------
-- agents
-- ---------------------------------------------------------------------------
drop policy if exists "agents_select" on public.agents;
drop policy if exists "agents_insert" on public.agents;
drop policy if exists "agents_update" on public.agents;
drop policy if exists "agents_delete" on public.agents;

create policy "agents_select"
  on public.agents
  for select
  to authenticated
  using (
    owner_id = (select auth.uid()) or public.is_admin((select auth.uid()))
  );

create policy "agents_insert"
  on public.agents
  for insert
  to authenticated
  with check (
    owner_id = (select auth.uid()) or public.is_admin((select auth.uid()))
  );

create policy "agents_update"
  on public.agents
  for update
  to authenticated
  using (
    owner_id = (select auth.uid()) or public.is_admin((select auth.uid()))
  )
  with check (
    owner_id = (select auth.uid()) or public.is_admin((select auth.uid()))
  );

create policy "agents_delete"
  on public.agents
  for delete
  to authenticated
  using (
    owner_id = (select auth.uid()) or public.is_admin((select auth.uid()))
  );

-- ---------------------------------------------------------------------------
-- campaigns
-- ---------------------------------------------------------------------------
drop policy if exists "campaigns_select" on public.campaigns;
drop policy if exists "campaigns_insert" on public.campaigns;
drop policy if exists "campaigns_update" on public.campaigns;
drop policy if exists "campaigns_delete" on public.campaigns;

create policy "campaigns_select"
  on public.campaigns
  for select
  to authenticated
  using (
    owner_id = (select auth.uid()) or public.is_admin((select auth.uid()))
  );

create policy "campaigns_insert"
  on public.campaigns
  for insert
  to authenticated
  with check (
    owner_id = (select auth.uid()) or public.is_admin((select auth.uid()))
  );

create policy "campaigns_update"
  on public.campaigns
  for update
  to authenticated
  using (
    owner_id = (select auth.uid()) or public.is_admin((select auth.uid()))
  )
  with check (
    owner_id = (select auth.uid()) or public.is_admin((select auth.uid()))
  );

create policy "campaigns_delete"
  on public.campaigns
  for delete
  to authenticated
  using (
    owner_id = (select auth.uid()) or public.is_admin((select auth.uid()))
  );
