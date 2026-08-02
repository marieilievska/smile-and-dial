-- Open Twilio numbers and custom fields to members (repurposed "builder" role).
-- Numbers: members can view the pool, buy/adopt, attach, and repoint webhooks.
-- The UPDATE guardrail blocks touching a number attached to ANOTHER user's
-- campaign (so a member can't yank a number out from under a teammate's live
-- campaign). Permanent DELETE stays admin-only (unchanged; done via service
-- role after an admin code-check).
-- Custom fields: members can create + edit (needed for lead import); DELETE
-- stays admin-only (dropping a field destroys that column's data for everyone).
-- Relaxing-only: no drops/renames of columns; existing admin behavior unchanged.

-- --- twilio_numbers -------------------------------------------------------
drop policy if exists "twilio_numbers_select" on public.twilio_numbers;
create policy "twilio_numbers_select"
  on public.twilio_numbers for select to authenticated
  using (true);

drop policy if exists "twilio_numbers_insert" on public.twilio_numbers;
create policy "twilio_numbers_insert"
  on public.twilio_numbers for insert to authenticated
  with check (true);

drop policy if exists "twilio_numbers_update" on public.twilio_numbers;
create policy "twilio_numbers_update"
  on public.twilio_numbers for update to authenticated
  using (
    public.is_admin((select auth.uid()))
    or attached_campaign_id is null
    or exists (
      select 1 from public.campaigns c
      where c.id = public.twilio_numbers.attached_campaign_id
        and c.owner_id = (select auth.uid())
    )
  )
  with check (
    public.is_admin((select auth.uid()))
    or attached_campaign_id is null
    or exists (
      select 1 from public.campaigns c
      where c.id = public.twilio_numbers.attached_campaign_id
        and c.owner_id = (select auth.uid())
    )
  );
-- twilio_numbers DELETE policy intentionally unchanged (admin-only).

-- --- custom_field_defs ----------------------------------------------------
drop policy if exists "custom_field_defs_insert" on public.custom_field_defs;
create policy "custom_field_defs_insert"
  on public.custom_field_defs for insert to authenticated
  with check (true);

drop policy if exists "custom_field_defs_update" on public.custom_field_defs;
create policy "custom_field_defs_update"
  on public.custom_field_defs for update to authenticated
  using (true) with check (true);
-- custom_field_defs SELECT already (true); DELETE intentionally unchanged
-- (admin-only).
