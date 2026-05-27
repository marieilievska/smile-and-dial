-- The Close webhook upserts on close_message_id; that needs a unique
-- constraint to work as an ON CONFLICT target.
drop index if exists emails_close_message_id_idx;

create unique index if not exists emails_close_message_id_unique
  on public.emails (close_message_id)
  where close_message_id is not null;
