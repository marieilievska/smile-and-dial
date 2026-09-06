-- DNC uniqueness per user: unique (owner_id, phone) instead of unique (phone).
--
-- 20260905192000 made DNC lists per user (owner_id + fill trigger, per-user
-- RLS) but deliberately KEPT `unique (phone)`: the ElevenLabs post-call
-- webhook upserted with `ON CONFLICT (phone) DO NOTHING`, and Postgres
-- refuses that clause the moment no unique index on exactly (phone) exists --
-- so swapping the constraint first would have silently stopped AI-detected
-- DNC numbers from being written. Every writer now conflicts on
-- (owner_id, phone) (post-call webhook, mark_dnc tool, Close STOP webhook,
-- addToDnc / bulkAddLeadsToDnc, the DNC import, the inline Stage picker), so
-- the constraint can follow.
--
-- Deploy order (feedback_migration_sequencing): the code that upserts on
-- (owner_id, phone) must be live BEFORE this runs -- `ON CONFLICT
-- (owner_id, phone)` needs the new unique index to exist, and `ON CONFLICT
-- (phone)` needs the old one. Ship the PR, let Vercel deploy, then push.
--
-- What changes
--   * two users can each list the same number (one row per owner); a user's
--     "already on the DNC list" now means THEIR list;
--   * a plain index on (phone) replaces the one the dropped unique constraint
--     provided, so dial-time enforcement keeps its lookup: dial_queue
--     (20260810130000), pre_call_check (20260724120000) and is_phone_on_dnc
--     (20260525152154) all match on phone alone and stay untouched -- a
--     number on ANY user's list still blocks the dialer for everyone.
--
-- Rows with a null owner_id (the trigger only leaves one null when it finds
-- no admin at all) are treated as distinct by the unique constraint; the
-- trigger and the backfill in 20260905192000 mean none exist in practice.

-- The original `phone text not null unique` (20260525152154) named its
-- constraint dnc_entries_phone_key; drop by name, and by shape in case an
-- environment carries a different name.
do $$
declare
  c record;
begin
  for c in
    select con.conname
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
     where nsp.nspname = 'public'
       and rel.relname = 'dnc_entries'
       and con.contype = 'u'
       and con.conkey = array[
         (select attnum from pg_attribute
           where attrelid = rel.oid and attname = 'phone')
       ]::int2[]
  loop
    execute format(
      'alter table public.dnc_entries drop constraint %I', c.conname
    );
  end loop;
end
$$;

alter table public.dnc_entries
  drop constraint if exists dnc_entries_owner_phone_key;
alter table public.dnc_entries
  add constraint dnc_entries_owner_phone_key unique (owner_id, phone);

-- Dial-time lookups (where phone = ...) used the unique index; keep one.
create index if not exists dnc_entries_phone_idx
  on public.dnc_entries (phone);

comment on constraint dnc_entries_owner_phone_key on public.dnc_entries is
  'One row per (owner, phone): each user keeps their own list; the dialer '
  'still refuses a phone on ANY list (matched on phone alone).';
