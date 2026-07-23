-- Widen the per-campaign concurrency cap from "1..5" to "1..20".
--
-- The old check (from create_campaigns.sql) hard-limited
-- concurrency_cap_per_user to 5 at the DB level — the real reason the campaign
-- settings field couldn't be raised, on top of the UI max and the server clamp
-- (both fixed in the paired code change). 20 is the ElevenLabs Pro workspace
-- concurrency limit (shared workspace-wide, including inbound), the true ceiling.
--
-- Safe: only WIDENS the allowed range, so every existing row (all ≤ 5) still
-- satisfies it. No column drop/rename.

alter table public.campaigns
  drop constraint if exists campaigns_concurrency_cap_per_user_check;

alter table public.campaigns
  add constraint campaigns_concurrency_cap_per_user_check
    check (concurrency_cap_per_user between 1 and 20);
