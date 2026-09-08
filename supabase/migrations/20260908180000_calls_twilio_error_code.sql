-- calls.twilio_error_code: WHY a call failed, in Twilio's own words.
--
-- The reconciler (#505, src/lib/calls/reconcile-twilio-status.ts) re-reads
-- calls we recorded as `failed` against Twilio's Calls resource and relabels
-- the ones that were really no-answer or busy. It reads only the STATUS. But
-- `failed` covers two completely different things, and telling them apart is
-- the whole question:
--
--   * the DESTINATION is dead   -- the number is invalid or unreachable by
--                                  nature, and dialling it again is waste;
--   * something on OUR side broke -- a bridging fault, a permissions gap, a
--                                  quota. The number may be perfectly live.
--
-- Twilio's `error_code` is the field that separates them. On 2026-09-08, all
-- 47 calls sitting at `failed` after the reconcile carried NO error code at
-- all, price $0.00000, and an ElevenLabs conversation stuck at `initiated` —
-- an ElevenLabs bridging fault, not 47 dead numbers. Nothing recorded that,
-- because nothing stored the code.
--
-- So: store it on every reconcile pass, including when it is null and
-- including when nothing else about the row changes. The suppression list in
-- reconcile-twilio-status.ts is deliberately two codes long and grows only on
-- observed evidence; this column IS that evidence. Nullable forever — a call
-- that succeeded has no error code, and neither does one Twilio never
-- attributed.
--
-- Read-only bookkeeping: no index (nothing filters on it at dial time; the
-- census that reads it is a one-off group-by over a day's rows), no
-- constraint (Twilio's code space is theirs to extend), no backfill possible
-- (the reconciler fills it going forward, and only inside its window).

alter table public.calls
  add column if not exists twilio_error_code integer;

comment on column public.calls.twilio_error_code is
  'Twilio''s error_code for this call, as read back from the Calls resource '
  'by the reconciler; NULL when Twilio reported none. This is WHY a call '
  'failed, as opposed to status which only says THAT it failed. Two codes -- '
  '13224 (Twilio will not call this number / it is invalid) and 21211 '
  '(invalid To number) -- mean the destination itself is dead and send the '
  'lead to DNC with reason ''invalid_number''. Everything else, 21215 '
  '(geo-permissions: OUR account may not call that region) and a null code '
  '(an ElevenLabs bridging fault) especially, is a problem of ours and never '
  'suppresses a lead. Persisted on every pass so the suppression list can '
  'grow on evidence rather than on guesswork.';
