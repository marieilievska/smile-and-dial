-- Drop the database objects a full audit on 2026-09-05 found dead: nothing in
-- src/ reads or writes them, no live function / view / trigger / policy
-- references them, and every row-level check came back empty (read-only
-- PostgREST counts taken the same day). Every statement is guarded with
-- IF EXISTS so the migration is safe to re-run and cannot fail on an
-- environment that never had the object.
--
-- Deliberately NOT touched here:
--   knowledge_bases.elevenlabs_kb_id
--       a knowledge-base sync feature is being built on it.
--   smart_list_members_lead_idx
--       smart lists rely on it.
--   twilio_numbers.last_connect_rate_check_at
--       still written by monitor_twilio_connect_rates (latest copy in
--       20260903233000_connected_outcomes_unified.sql).
--   is_within_calling_hours(text, time, time, boolean)
--       the live 4-arg overload the dial_queue view and pre_call_check call.
--   leads.status CHECK
--       unchanged.

-- 1. Hot Leads dismissals. The Hot Leads tab was removed from Reporting and
--    its only writer (dismissHotLead) goes in the same change. 0 rows.
drop policy if exists "admins read hot_lead_dismissals"
  on public.hot_lead_dismissals;
drop table if exists public.hot_lead_dismissals;

-- 2. The legacy ElevenLabs voice-id list. Voices are baked into
--    src/lib/elevenlabs/voices.ts (FIXED_VOICES); the column held a stale
--    comma-separated copy of those same ids, and the RPC that exposed it to
--    the old agent wizard has no caller in src/.
drop function if exists public.elevenlabs_voice_ids();
alter table public.app_settings drop column if exists elevenlabs_voice_ids;

-- 3. The pre-weekend 3-arg overload of is_within_calling_hours.
--    20260705120000 added the 4-arg (allow_weekends) version and left this one
--    "in place, unreferenced"; every caller since 20260721120000 (the
--    dial_queue view, pre_call_check) passes four arguments.
drop function if exists public.is_within_calling_hours(text, time, time);

-- 4. Columns with zero readers and zero writers in src/ and in every live
--    function, view, trigger and policy. Null / default on every row.
alter table public.calls drop column if exists theme;
alter table public.calls drop column if exists suggested_action;
alter table public.profiles drop column if exists notify_on_goal_met;
alter table public.profiles drop column if exists notify_on_email_reply;
alter table public.profiles drop column if exists avatar_url;
alter table public.profiles drop column if exists last_login_at;
alter table public.leads drop column if exists utm_campaign;

-- 5. Indexes the planner never uses (0 scans since creation).
drop index if exists public.idx_leads_dial_eligible;
drop index if exists public.calls_local_match_idx;
drop index if exists public.calls_dest_country_idx;

-- 6. Retire the 'dm_reached' outcome value. Reaching the decision-maker is a
--    standalone flag, never an outcome: no code writes outcome = 'dm_reached'
--    and 0 calls carry it. The list below is the one from
--    20260811170000_add_gatekeeper_not_interested_outcome.sql minus that value.
alter table public.calls drop constraint if exists calls_outcome_check;
alter table public.calls
  add constraint calls_outcome_check check (
    outcome is null
    or outcome in (
      'voicemail', 'no_answer', 'busy', 'failed', 'hung_up_immediately',
      'hung_up_later', 'invalid_number', 'gatekeeper', 'gatekeeper_not_interested',
      'not_interested', 'callback', 'dnc', 'goal_met', 'language_barrier',
      'ai_receptionist', 'ai_error', 'transferred_to_human',
      'call_back_later'
    )
  );
