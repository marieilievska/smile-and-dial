-- ---------------------------------------------------------------------------
-- Per-campaign follow-up openers (2026-09-12).
--
-- On 2026-09-12, 51% of scheduled callbacks (40 of 78) opened with the cold
-- "weirdest call you get today" pitch. The prompt asked the agent to choose an
-- opener by condition, but ElevenLabs substitutes {{variables}} before the
-- model reads the prompt, so a rule like (when {{call_type}} is "cold")
-- reached the model as (when callback is "cold"). Code now picks the situation
-- and sends one instruction, {{opening_instruction}}
-- (src/lib/elevenlabs/opening-line.ts); these columns hold the line it tells
-- the agent to say.
--
--   callback_opener       a callback is booked with this business in this
--                         campaign
--   spoken_before_opener  a real conversation happened in this campaign and no
--                         callback is booked (a front desk, a "not interested"
--                         after its rest, a missed callback)
--
-- Both are the agent's first REPLY, after the business answers — never a first
-- message. {when} is filled in by code ("yesterday", "about a month ago").
-- NULL or blank = the default line (DEFAULT_CALLBACK_OPENER /
-- DEFAULT_SPOKEN_BEFORE_OPENER in opening-line.ts); the length cap
-- (OPENER_MAX_LENGTH) lives there too, not in the database. Additive and
-- nullable: safe to apply before the code that reads them deploys.
-- ---------------------------------------------------------------------------

-- The dialer reads campaigns every minute. Adding a nullable column is instant,
-- but it still needs an ACCESS EXCLUSIVE lock, and while it waits for one every
-- new read of campaigns queues behind it. Give up after 5s, so call-start reads
-- stall at most 5s behind a long transaction. A failed push is safe to re-run.
set lock_timeout = '5s';

alter table public.campaigns
  add column if not exists callback_opener text,
  add column if not exists spoken_before_opener text;

comment on column public.campaigns.callback_opener is
  'The agent''s first reply, after the business answers, when a callback is booked with this business in this campaign. {when} is filled in by code. NULL or blank = the default line in src/lib/elevenlabs/opening-line.ts.';
comment on column public.campaigns.spoken_before_opener is
  'The agent''s first reply, after the business answers, when we have had a real conversation with this business in this campaign and no callback is booked. {when} is filled in by code. NULL or blank = the default line in src/lib/elevenlabs/opening-line.ts.';

-- Don't leave the 5s limit on the CLI's connection for later migrations.
reset lock_timeout;
