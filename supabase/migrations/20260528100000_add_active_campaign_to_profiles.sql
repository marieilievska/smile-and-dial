-- Round 27 — Active campaign per user
--
-- Marija asked for a top-bar campaign chip so manual calls
-- (the "Call Now" button on lead detail, future quick-dial controls,
-- etc.) automatically use one campaign's agent + Twilio number
-- without prompting every time.
--
-- The active campaign is a per-operator preference, so it lives on
-- `profiles`. Nullable because new users won't have one set; the UI
-- falls back to prompting in that case.

alter table public.profiles
  add column if not exists active_campaign_id uuid
    references public.campaigns(id) on delete set null;

comment on column public.profiles.active_campaign_id is
  'Per-user default campaign for manual call actions. When set, the Call Now button and other ad-hoc dial controls pre-fill this campaign without asking. SET NULL on delete so a paused/ended campaign doesn''t orphan the reference.';
