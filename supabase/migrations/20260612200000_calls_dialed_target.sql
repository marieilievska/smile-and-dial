-- Record which of the lead's two numbers a call dialed.
--
-- Leads carry both a business line (business_phone) and the owner's direct line
-- (owner_phone). Until now every call went to the business line, so there was
-- nothing to record. The lead-detail "call the owner" control lets a call (AI or
-- manual) target the owner's number instead, and the Calls list / lead timeline
-- need to tell the two apart ("→ Owner").
--
-- Nullable: existing rows + ordinary business-line calls stay null, which the UI
-- treats the same as 'business'. Only owner-targeted calls set 'owner'.
alter table public.calls
  add column if not exists dialed_target text
    check (dialed_target is null or dialed_target in ('business', 'owner'));

comment on column public.calls.dialed_target is
  'Which lead number this call dialed: ''owner'' = the owner''s direct line; ''business'' or null = the business line.';
