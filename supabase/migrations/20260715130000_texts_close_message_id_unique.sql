-- Atomic idempotency for the inbound-SMS webhook, mirroring the emails table
-- (20260526155911). Lets handleInboundSms rely on a 23505 on retry instead of a
-- racy check-then-insert, so a Close webhook retry can't produce duplicate rows.
create unique index if not exists texts_close_message_id_unique
  on public.texts (close_message_id)
  where close_message_id is not null;
