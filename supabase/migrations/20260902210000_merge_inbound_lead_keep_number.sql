-- ---------------------------------------------------------------------------
-- merge_inbound_lead v2: keep the caller's number + carry the whole history.
--
-- v1 (20260601140000) repointed calls + callbacks and soft-deleted the source.
-- Two gaps showed up on the first live webinar day (2026-09-02), when 14
-- people returned a missed call from a DIFFERENT number than the one we dialed
-- (their cell, a second line) and landed as orphan "Inbound" leads:
--
--   1. The caller's number was lost with the soft-deleted source, so the next
--      call from that same number created ANOTHER orphan. v2 stores it on the
--      destination (mobile_phone, else owner_phone, else only in the audit
--      payload) and the inbound webhook now matches on all three phone columns.
--   2. Only calls + callbacks moved. The per-campaign rolling summary the
--      inbound call wrote, any custom-field values, texts, emails, short links
--      and Calendly bookings stayed on the dead source. v2 moves all of them,
--      appending a summary when the destination already has one for that
--      campaign.
--
-- It also carries state forward: a pending callback parks the destination on
-- it (status='callback', next_call_at=earliest pending), a booked/DNC source
-- marks the destination the same way, conversation counters add up, and
-- last_call_at / decision_maker_reached take the later / truer value.
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
  if in_actor is not null and v_source.owner_id is distinct from in_actor then
    if not public.is_admin(in_actor) then
      raise exception 'caller does not own these leads';
    end if;
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

  -- 4. Carry state forward onto the destination.
  update public.leads
     set conversations = conversations + coalesce(v_source.conversations, 0),
         last_call_at  = greatest(coalesce(last_call_at, v_source.last_call_at),
                                  coalesce(v_source.last_call_at, last_call_at)),
         decision_maker_reached = decision_maker_reached or coalesce(v_source.decision_maker_reached, false),
         updated_at = now()
   where id = in_destination_lead_id;

  -- Terminal states win: a booked or DNC'd caller stays booked / DNC'd.
  if v_source.status in ('goal_met', 'dnc') and v_dest.status not in ('goal_met', 'dnc') then
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

  -- 6. Audit.
  insert into public.system_events (kind, actor_user_id, ref_table, ref_id, payload)
  values (
    'lead_merged',
    in_actor,
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
  'callbacks, summaries, custom values, texts, emails, links, bookings, carry '
  'callback/goal_met/dnc status, soft-delete the source, write the audit row.';

grant execute on function public.merge_inbound_lead(uuid, uuid, jsonb, uuid)
  to authenticated;
