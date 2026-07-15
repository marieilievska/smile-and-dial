-- Per-call structured "pickup" note for whoever calls this business next.
-- Generated after a connected call (alongside the rolling per-campaign summary)
-- and surfaced as the {{last_callback_notes}} dynamic variable on a scheduled
-- callback. Purely additive — nothing reads it until the new code deploys, and
-- the conversation-init webhook falls back to calls.summary when it's null (old
-- callback rows predate this column).
alter table public.calls add column if not exists callback_notes text;
