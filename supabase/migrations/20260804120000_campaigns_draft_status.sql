-- Add a 'draft' campaign status. Campaigns are now created as drafts and do NOT
-- dial until explicitly launched (draft -> active). The dialer already gates on
-- status = 'active', so a draft simply never dials.
--
-- The check constraint must accept 'draft' BEFORE any code writes it, so this
-- migration ships ahead of the code deploy. It's backward-compatible: it only
-- widens the allowed set, and nothing produces 'draft' until the code lands. The
-- column default stays 'active' (createCampaign now sets the status explicitly).

alter table public.campaigns
  drop constraint if exists campaigns_status_check;

alter table public.campaigns
  add constraint campaigns_status_check
  check (status in ('draft', 'active', 'paused', 'ended'));
