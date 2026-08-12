-- Reusable "merge one campaign into another" — fold a source campaign's whole
-- footprint into a target campaign in ONE transaction, then end the source.
-- Moves: lead ownership, list attachments, callbacks, per-campaign summaries
-- (newest-wins on conflict), and phone numbers. Deliberately does NOT move
-- calls (calls.campaign_id) — historical per-campaign reporting stays accurate;
-- the ended source keeps its record.
--
-- Owner-safe: both campaigns must belong to the same owner, and EXECUTE is
-- granted to service_role only — the server action verifies the caller owns them
-- before invoking it (so an authenticated user can't call it directly).

create or replace function public.merge_campaign(p_source uuid, p_target uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_src uuid;
  v_owner_tgt uuid;
  v_leads int := 0;
  v_lists int := 0;
  v_callbacks int := 0;
  v_summaries int := 0;
  v_numbers int := 0;
begin
  if p_source = p_target then
    raise exception 'merge_campaign: source and target must differ';
  end if;
  select owner_id into v_owner_src from public.campaigns where id = p_source;
  select owner_id into v_owner_tgt from public.campaigns where id = p_target;
  if v_owner_src is null then
    raise exception 'merge_campaign: source campaign % not found', p_source;
  end if;
  if v_owner_tgt is null then
    raise exception 'merge_campaign: target campaign % not found', p_target;
  end if;
  if v_owner_src <> v_owner_tgt then
    raise exception 'merge_campaign: campaigns have different owners';
  end if;

  -- 1) Lead ownership → target (these leads now belong to the target's dialing).
  update public.leads
     set owner_campaign_id = p_target, updated_at = now()
   where owner_campaign_id = p_source;
  get diagnostics v_leads = row_count;

  -- 2) List attachments: move the source's active attachments the target lacks;
  --    detach any the target already has (avoids a duplicate active attachment).
  update public.list_campaign_attachments a
     set campaign_id = p_target
   where a.campaign_id = p_source
     and a.detached_at is null
     and not exists (
       select 1 from public.list_campaign_attachments b
        where b.campaign_id = p_target and b.list_id = a.list_id
          and b.detached_at is null);
  get diagnostics v_lists = row_count;
  update public.list_campaign_attachments
     set detached_at = now()
   where campaign_id = p_source and detached_at is null;

  -- 3) Callbacks → target.
  update public.callbacks set campaign_id = p_target where campaign_id = p_source;
  get diagnostics v_callbacks = row_count;

  -- 4) Per-campaign summaries (unique on lead_id+campaign_id): newest wins.
  --    Drop source rows a newer/equal target row already covers; drop target
  --    rows the source beats; then move the remaining source rows over.
  delete from public.lead_campaign_summaries s
   where s.campaign_id = p_source
     and exists (
       select 1 from public.lead_campaign_summaries t
        where t.campaign_id = p_target and t.lead_id = s.lead_id
          and t.updated_at >= s.updated_at);
  delete from public.lead_campaign_summaries t
   where t.campaign_id = p_target
     and exists (
       select 1 from public.lead_campaign_summaries s
        where s.campaign_id = p_source and s.lead_id = t.lead_id
          and s.updated_at > t.updated_at);
  update public.lead_campaign_summaries
     set campaign_id = p_target
   where campaign_id = p_source;
  get diagnostics v_summaries = row_count;

  -- 5) Phone numbers → target.
  update public.twilio_numbers
     set attached_campaign_id = p_target
   where attached_campaign_id = p_source;
  get diagnostics v_numbers = row_count;

  -- 6) End the source — its footprint now lives on the target. Clear its
  --    primary-number link (numbers already reattached above).
  update public.campaigns
     set status = 'ended', ended_at = now(), twilio_number_id = null
   where id = p_source;

  return jsonb_build_object(
    'source', p_source, 'target', p_target,
    'leads', v_leads, 'lists', v_lists, 'callbacks', v_callbacks,
    'summaries', v_summaries, 'numbers', v_numbers);
end;
$$;

comment on function public.merge_campaign is
  'Fold a source campaign into a target (leads/lists/callbacks/summaries/numbers) '
  'in one transaction, then end the source. Does NOT move calls. service_role only; '
  'caller ownership is enforced by the mergeCampaign server action.';

revoke execute on function public.merge_campaign(uuid, uuid) from public;
revoke execute on function public.merge_campaign(uuid, uuid) from authenticated;
grant execute on function public.merge_campaign(uuid, uuid) to service_role;
