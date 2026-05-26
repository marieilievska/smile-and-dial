-- Inbound default list. When an inbound call hits a Twilio number we own
-- and the caller's phone doesn't match any existing lead, the inbound
-- routing handler (Step 29) creates a new lead in the owner's
-- system-managed "Inbound" list. At most one per owner.
--
-- BUILD_PLAN §6 line 558: "create a new lead in a system-managed 'Inbound'
-- List under the campaign's owner".

alter table public.lists
  add column is_inbound_default boolean not null default false;

comment on column public.lists.is_inbound_default is
  'Marks the system-managed "Inbound" list for an owner. Auto-created '
  'inbound leads land here when no existing lead matches the caller phone.';

-- One inbound default per owner. Partial unique index lets normal lists
-- coexist freely.
create unique index lists_one_inbound_default_per_owner
  on public.lists (owner_id)
  where is_inbound_default = true;

-- ---------------------------------------------------------------------------
-- Helper: return (and lazily create) the inbound default list for an owner.
-- Security-definer so the inbound webhook (service role) and any callers
-- can both reach it consistently.
-- ---------------------------------------------------------------------------
create or replace function public.get_or_create_inbound_list(in_owner uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_list_id uuid;
begin
  select id into v_list_id
    from public.lists
   where owner_id = in_owner
     and is_inbound_default = true
   limit 1;
  if v_list_id is not null then
    return v_list_id;
  end if;

  insert into public.lists (owner_id, name, description, is_inbound_default)
  values (in_owner, 'Inbound', 'Auto-created leads from inbound calls.', true)
  returning id into v_list_id;
  return v_list_id;
end;
$$;

grant execute on function public.get_or_create_inbound_list(uuid) to authenticated;
