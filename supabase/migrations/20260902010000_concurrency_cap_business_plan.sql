-- Widen the per-campaign concurrency cap from "1..30" to "1..40".
--
-- The ElevenLabs workspace moved to the Business plan on 2026-09-02, taking the
-- simultaneous-conversation limit from 30 to 40. That limit is the real ceiling
-- on this setting, so the DB check follows it (as it did 20 -> 30 on 2026-08-03
-- for Scale, migration 20260803220000).
--
-- This is the third of three gates that must move together, and the one that is
-- easiest to miss because the other two fail loudly and this one fails as a
-- constraint violation on save:
--   1. the input max in campaign-settings-dialog.tsx
--   2. the Math.min() clamp in src/lib/campaigns/actions.ts
--   3. this constraint
--
-- NOTE the limit is shared workspace-wide INCLUDING inbound, and pre_call_check
-- counts the OWNER's live calls (not the campaign's) against whichever
-- campaign's cap it is checking — so two campaigns both set to 40 share one
-- 40-call budget rather than getting 40 each.
--
-- Safe: only WIDENS the allowed range, so every existing row (all <= 30) still
-- satisfies it. No column drop/rename, no data change.

alter table public.campaigns
  drop constraint if exists campaigns_concurrency_cap_per_user_check;

alter table public.campaigns
  add constraint campaigns_concurrency_cap_per_user_check
    check (concurrency_cap_per_user between 1 and 40);
