-- ---------------------------------------------------------------------------
-- merge_inbound_lead v4: carry the BOOKING across, not just its rows.
--
-- v2/v3 repoint the source's calendly_events rows and carry goal_met/dnc, but
-- never copy leads.calendly_event_uri. On 2026-09-10 Donna (Ascendance Pilates)
-- returned our voicemail from her cell, landed as an orphan "Inbound" lead,
-- and booked the webinar on that call — so the orphan held the booking link.
-- The merge on 2026-09-11 moved the calendly_events row and the goal_met status
-- but left the real lead with calendly_event_uri = null: a booked lead that
-- reads as "goal_met with no booking" to anything checking the lead.
--
-- Body copied verbatim from 20260905170000 (v3). ONLY step 4 changes:
--   * calendly_event_uri: keep the destination's, else take the source's.
--   * a 'scheduled' source (booked, but the call wasn't labelled goal_met)
--     now carries like goal_met/dnc. Before, the destination stayed
--     ready_to_call and the dialer could ring a lead that had just booked.
-- Signature, grants and authorisation unchanged.
-- ---------------------------------------------------------------------------
create or replace function public.merge_inbound_lead(
  in_source_lead_id uuid,
  in_destination_lead_id uuid,
  in_patch jsonb,
  in_actor uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source public.leads%rowtype;
  v_dest public.leads%rowtype;
  v_source_inbound boolean;
  v_phone text;
  v_phone_slot text := null;
  v_summary record;
  v_earliest_cb timestamptz;
  v_new_status text := null;
  v_actor uuid;
begin
  if in_source_lead_id = in_destination_lead_id then
    raise exception 'source and destination must differ';
  end if;

  -- Lock both rows for the duration of the transaction so a concurrent
  -- merge / edit can't race us.
  select * into v_source from public.leads
   where id = in_source_lead_id and deleted_at is null
   for update;
  if not found then
    raise exception 'source lead not found';
  end if;

  select * into v_dest from public.leads
   where id = in_destination_lead_id and deleted_at is null
   for update;
  if not found then
    raise exception 'destination lead not found';
  end if;

  -- Ownership + caller checks (defense in depth over the action's RLS reads).
  if v_source.owner_id is distinct from v_dest.owner_id then
    raise exception 'leads have different owners';
  end if;

  -- Who is acting? A user-scoped call carries auth.uid() and that wins over
  -- in_actor; an internal (service_role) call has no auth.uid() and must say
  -- who it acts for. Either way the actor must own the leads or be an admin.
  v_actor := auth.uid();
  if v_actor is null then
    v_actor := in_actor;
  end if;
  if v_actor is null then
    raise exception 'merge_inbound_lead requires an authenticated caller or an explicit in_actor';
  end if;
  if v_source.owner_id is distinct from v_actor and not public.is_admin(v_actor) then
    raise exception 'caller does not own these leads';
  end if;

  -- Source must be an auto-created inbound lead.
  select coalesce(l.is_inbound_default, false) into v_source_inbound
    from public.lists l
   where l.id = v_source.list_id;
  if not coalesce(v_source_inbound, false) then
    raise exception 'only inbound leads can be merged';
  end if;

  -- 1. Patch the destination with the caller-computed field set (already
  --    filtered to "fill only where destination is empty" in the action).
  if in_patch is not null and in_patch <> '{}'::jsonb then
    update public.leads
       set company         = coalesce((in_patch->>'company'), company),
           business_email   = coalesce((in_patch->>'business_email'), business_email),
           owner_name       = coalesce((in_patch->>'owner_name'), owner_name),
           owner_phone      = coalesce((in_patch->>'owner_phone'), owner_phone),
           manager_name     = coalesce((in_patch->>'manager_name'), manager_name),
           employee_name    = coalesce((in_patch->>'employee_name'), employee_name),
           website          = coalesce((in_patch->>'website'), website),
           category         = coalesce((in_patch->>'category'), category),
           city             = coalesce((in_patch->>'city'), city),
           state            = coalesce((in_patch->>'state'), state),
           google_place_id  = coalesce((in_patch->>'google_place_id'), google_place_id)
     where id = in_destination_lead_id;
    -- Re-read so the phone-slot logic below sees the patched row.
    select * into v_dest from public.leads where id = in_destination_lead_id;
  end if;

  -- 2. Keep the number the caller used. The source's business_phone IS the
  --    caller ID of the inbound call. Store it on the destination in the first
  --    empty phone slot so the next call from it matches this lead directly.
  v_phone := nullif(trim(v_source.business_phone), '');
  if v_phone is not null
     and v_phone is distinct from v_dest.business_phone
     and v_phone is distinct from v_dest.mobile_phone
     and v_phone is distinct from v_dest.owner_phone then
    if v_dest.mobile_phone is null or v_dest.mobile_phone = '' then
      update public.leads set mobile_phone = v_phone where id = in_destination_lead_id;
      v_phone_slot := 'mobile_phone';
    elsif v_dest.owner_phone is null or v_dest.owner_phone = '' then
      update public.leads set owner_phone = v_phone where id = in_destination_lead_id;
      v_phone_slot := 'owner_phone';
    else
      v_phone_slot := 'audit_only';
    end if;
  elsif v_phone is not null then
    v_phone_slot := 'already_present';
  end if;

  -- 3. Repoint history to the destination.
  update public.calls     set lead_id = in_destination_lead_id where lead_id = in_source_lead_id;
  update public.callbacks set lead_id = in_destination_lead_id where lead_id = in_source_lead_id;
  update public.texts     set lead_id = in_destination_lead_id where lead_id = in_source_lead_id;
  update public.emails    set lead_id = in_destination_lead_id where lead_id = in_source_lead_id;
  update public.short_links     set lead_id = in_destination_lead_id where lead_id = in_source_lead_id;
  update public.calendly_events set lead_id = in_destination_lead_id where lead_id = in_source_lead_id;

  -- Per-campaign rolling summaries: move when the destination has none for
  -- that campaign, otherwise append the source's text to the destination's.
  for v_summary in
    select id, campaign_id, ai_summary
      from public.lead_campaign_summaries
     where lead_id = in_source_lead_id
  loop
    if exists (
      select 1 from public.lead_campaign_summaries
       where lead_id = in_destination_lead_id and campaign_id = v_summary.campaign_id
    ) then
      if nullif(trim(v_summary.ai_summary), '') is not null then
        update public.lead_campaign_summaries
           set ai_summary = case
                 when nullif(trim(ai_summary), '') is null then v_summary.ai_summary
                 else ai_summary || E'\n\n' || v_summary.ai_summary
               end,
               updated_at = now()
         where lead_id = in_destination_lead_id and campaign_id = v_summary.campaign_id;
      end if;
      delete from public.lead_campaign_summaries where id = v_summary.id;
    else
      update public.lead_campaign_summaries
         set lead_id = in_destination_lead_id
       where id = v_summary.id;
    end if;
  end loop;

  -- Custom-field values: fill what the destination lacks, drop the rest.
  update public.lead_custom_values s
     set lead_id = in_destination_lead_id
   where s.lead_id = in_source_lead_id
     and not exists (
       select 1 from public.lead_custom_values d
        where d.lead_id = in_destination_lead_id
          and d.custom_field_id = s.custom_field_id
     );
  delete from public.lead_custom_values where lead_id = in_source_lead_id;

  -- Smart-list membership is recomputed by the smart-list job; the source is
  -- going away, so just drop its rows.
  delete from public.smart_list_members where lead_id = in_source_lead_id;

  -- 4. Carry state forward onto the destination. The booking link travels
  --    with its calendly_events row (repointed in step 3): the destination's
  --    own link wins, else the source's.
  update public.leads
     set conversations = conversations + coalesce(v_source.conversations, 0),
         last_call_at  = greatest(coalesce(last_call_at, v_source.last_call_at),
                                  coalesce(v_source.last_call_at, last_call_at)),
         decision_maker_reached = decision_maker_reached or coalesce(v_source.decision_maker_reached, false),
         calendly_event_uri = coalesce(calendly_event_uri, v_source.calendly_event_uri),
         updated_at = now()
   where id = in_destination_lead_id;

  -- Terminal states win: a booked (goal_met / scheduled) or DNC'd caller stays
  -- booked / DNC'd.
  if v_source.status in ('goal_met', 'scheduled', 'dnc') and v_dest.status not in ('goal_met', 'dnc') then
    v_new_status := v_source.status;
    update public.leads
       set status = v_new_status, next_call_at = null
     where id = in_destination_lead_id;
  end if;

  -- A pending callback (now on the destination) parks it, unless terminal.
  if v_new_status is null and v_dest.status not in ('goal_met', 'dnc') then
    select min(scheduled_at) into v_earliest_cb
      from public.callbacks
     where lead_id = in_destination_lead_id and status = 'pending';
    if v_earliest_cb is not null then
      v_new_status := 'callback';
      update public.leads
         set status = 'callback', next_call_at = v_earliest_cb
       where id = in_destination_lead_id;
    end if;
  end if;

  -- 5. Soft-delete the source.
  update public.leads
     set deleted_at = now()
   where id = in_source_lead_id;

  -- 6. Audit. v_actor is auth.uid() for a user-scoped call, in_actor otherwise.
  insert into public.system_events (kind, actor_user_id, ref_table, ref_id, payload)
  values (
    'lead_merged',
    v_actor,
    'leads',
    in_destination_lead_id,
    jsonb_build_object(
      'from', in_source_lead_id,
      'to', in_destination_lead_id,
      'merged_phone', v_phone,
      'phone_stored_in', v_phone_slot,
      'status_carried', v_new_status
    )
  );
end;
$$;

comment on function public.merge_inbound_lead is
  'Atomically merge an inbound lead into a destination: patch empty fields, '
  'keep the caller''s number (mobile_phone/owner_phone), repoint calls, '
  'callbacks, summaries, custom values, texts, emails, links, bookings (and '
  'the booking link), carry callback/goal_met/scheduled/dnc status, soft-delete '
  'the source, write the audit row. Authorised by auth.uid() (owner or admin) '
  'when called by a user; an internal service_role call must pass in_actor.';
