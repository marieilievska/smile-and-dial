-- First-run onboarding state (Part B). Additive, nullable — safe to apply
-- before the code that reads them ships. welcome_seen_at gates the one-time
-- welcome primer; onboarding_dismissed_at hides the Getting started checklist.
alter table public.profiles
  add column if not exists welcome_seen_at timestamptz,
  add column if not exists onboarding_dismissed_at timestamptz;

-- Existing teammates already know the app — mark them as onboarded so ONLY
-- teammates invited after this migration get the welcome + checklist. New
-- profiles (created by handle_new_user) leave these null and get onboarding.
update public.profiles
set welcome_seen_at = now(),
    onboarding_dismissed_at = now()
where welcome_seen_at is null;
