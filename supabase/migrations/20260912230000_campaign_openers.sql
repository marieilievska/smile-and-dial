-- ---------------------------------------------------------------------------
-- Per-campaign follow-up openers (2026-09-12).
--
-- On 2026-09-12, 51% of scheduled callbacks (40 of 78) opened with the cold
-- "weirdest call you get today" pitch: the prompt asked the agent to choose
-- an opener by condition, and ElevenLabs substitutes {{variables}} before the
-- model reads them. Code now picks the situation and sends one instruction,
-- {{opening_instruction}}; these columns hold the line it tells the agent to say.
--
--   callback_opener       a callback is booked with this business in this
--                         campaign
--   spoken_before_opener  a real conversation happened in this campaign and no
--                         callback is booked (a front desk, a "not interested"
--                         after its rest, a missed callback)
--
-- Both are the agent's first REPLY, after the business answers — never a first
-- message. {when} is filled in by code ("yesterday", "about a month ago").
-- NULL = the app's default line. Additive and nullable: safe to apply before
-- the code that reads them deploys.
-- ---------------------------------------------------------------------------
alter table public.campaigns
  add column if not exists callback_opener text,
  add column if not exists spoken_before_opener text;
