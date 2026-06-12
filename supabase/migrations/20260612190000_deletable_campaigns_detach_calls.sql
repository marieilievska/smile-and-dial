-- Make campaigns deletable WITHOUT destroying their call history.
--
-- Before: calls.campaign_id and callbacks.campaign_id were NOT NULL with
-- ON DELETE RESTRICT, so any campaign that had ever placed a call (or scheduled
-- a callback) could not be deleted at all -- the foreign key blocked it. That
-- left finished / test campaigns permanently stuck on the board (e.g. an "ended"
-- campaign with hundreds of calls).
--
-- After: campaign_id is nullable and the FK is ON DELETE SET NULL. Deleting a
-- campaign now DETACHES its calls and callbacks (campaign_id -> NULL) and leaves
-- the rows intact -- the call records, recordings, and their cost/analytics
-- contributions all survive. A detached call simply shows "-" for its campaign
-- in the Calls list; a detached callback won't dial (its campaign is gone), which
-- is the right outcome once the campaign no longer exists.
--
-- This only RELAXES constraints (drops NOT NULL, softens the delete rule), so it
-- is backward-compatible: every code path that inserts a call/callback still
-- provides a campaign_id, and the SET NULL only ever fires on an explicit
-- campaign delete.
--
-- The constraint names are dropped via a lookup (rather than a hard-coded
-- `calls_campaign_id_fkey`) so this is correct regardless of how Postgres named
-- the original inline foreign key.

-- calls.campaign_id ---------------------------------------------------------
alter table public.calls
  alter column campaign_id drop not null;

do $$
declare
  v_name text;
begin
  select con.conname
    into v_name
    from pg_constraint con
   where con.conrelid = 'public.calls'::regclass
     and con.contype = 'f'
     and exists (
       select 1
         from pg_attribute att
        where att.attrelid = con.conrelid
          and att.attnum = any (con.conkey)
          and att.attname = 'campaign_id'
     )
   limit 1;

  if v_name is not null then
    execute format('alter table public.calls drop constraint %I', v_name);
  end if;
end $$;

alter table public.calls
  add constraint calls_campaign_id_fkey
    foreign key (campaign_id) references public.campaigns (id)
    on delete set null;

-- callbacks.campaign_id -----------------------------------------------------
alter table public.callbacks
  alter column campaign_id drop not null;

do $$
declare
  v_name text;
begin
  select con.conname
    into v_name
    from pg_constraint con
   where con.conrelid = 'public.callbacks'::regclass
     and con.contype = 'f'
     and exists (
       select 1
         from pg_attribute att
        where att.attrelid = con.conrelid
          and att.attnum = any (con.conkey)
          and att.attname = 'campaign_id'
     )
   limit 1;

  if v_name is not null then
    execute format('alter table public.callbacks drop constraint %I', v_name);
  end if;
end $$;

alter table public.callbacks
  add constraint callbacks_campaign_id_fkey
    foreign key (campaign_id) references public.campaigns (id)
    on delete set null;
