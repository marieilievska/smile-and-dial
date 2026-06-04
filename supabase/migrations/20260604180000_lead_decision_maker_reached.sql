-- A lead-level "have we ever reached the decision maker?" flag.
--
-- Decision-maker contact is a per-call signal (calls.outcome /
-- calls.extracted_data.decision_maker_reached), but the Leads table needs a
-- single sticky answer per lead: once any call reaches the owner / decision
-- maker, the lead has "reached the DM" and stays that way. The post-call
-- webhook flips this to TRUE on a qualifying call; it is never flipped back.
alter table public.leads
  add column if not exists decision_maker_reached boolean not null default false;

comment on column public.leads.decision_maker_reached is
  'TRUE once any call for this lead reached the decision maker (owner / buyer). Sticky — set by the post-call webhook, never cleared automatically.';
