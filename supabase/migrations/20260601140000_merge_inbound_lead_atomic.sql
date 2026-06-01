-- ---------------------------------------------------------------------------
-- Atomic inbound-lead merge (audit follow-up #4).
--
-- mergeInboundLead previously ran five sequential writes from the server
-- action with no transaction: patch destination -> repoint calls -> repoint
-- callbacks -> soft-delete source -> audit. A mid-sequence failure (e.g. the
-- callbacks repoint) left call/callback ownership half-moved while the
-- source lead was still live and visible -- corrupt, with no rollback, and a
-- retry would double-apply.
--
-- This wraps the whole merge in one Postgres function (implicitly a single
-- transaction): either every write commits or none do.
--
-- security definer so it can write across calls/callbacks/leads, but it
-- re-verifies the caller (in_actor) owns both leads (or is admin) and that
-- the source is an auto-created inbound lead -- the same guards the server
-- action applies, enforced again at the data layer.
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
    -- Allow admins through: they can merge any owner's leads.
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
  --    These columns mirror MERGEABLE_FIELDS in lead-actions.ts exactly; a
  --    key absent from the patch keeps the destination's existing value.
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
           google_place_id  = coalesce((in_patch->>'google_place_id'), google_place_id),
           ai_summary       = coalesce((in_patch->>'ai_summary'), ai_summary)
     where id = in_destination_lead_id;
  end if;

  -- 2. Repoint call + callback history to the destination.
  update public.calls
     set lead_id = in_destination_lead_id
   where lead_id = in_source_lead_id;

  update public.callbacks
     set lead_id = in_destination_lead_id
   where lead_id = in_source_lead_id;

  -- 3. Soft-delete the source.
  update public.leads
     set deleted_at = now()
   where id = in_source_lead_id;

  -- 4. Audit.
  insert into public.system_events (kind, actor_user_id, ref_table, ref_id, payload)
  values (
    'lead_merged',
    in_actor,
    'leads',
    in_destination_lead_id,
    jsonb_build_object('from', in_source_lead_id, 'to', in_destination_lead_id)
  );
end;
$$;

comment on function public.merge_inbound_lead is
  'Atomically merge an inbound lead into a destination: patch empty fields, '
  'repoint calls + callbacks, soft-delete the source, write the audit row -- '
  'all in one transaction. Re-verifies ownership and inbound-default status.';

grant execute on function public.merge_inbound_lead(uuid, uuid, jsonb, uuid)
  to authenticated;
