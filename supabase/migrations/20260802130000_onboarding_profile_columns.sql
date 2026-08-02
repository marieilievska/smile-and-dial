-- First-run onboarding state (Part B). Additive, nullable — safe to apply
-- before the code that reads them ships. welcome_seen_at gates the one-time
-- welcome primer; onboarding_dismissed_at hides the Getting started checklist.
alter table public.profiles
  add column if not exists welcome_seen_at timestamptz,
  add column if not exists onboarding_dismissed_at timestamptz;
