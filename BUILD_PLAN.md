# Smile & Dial — Build Plan (Final)

An internal AI calling platform for Referrizer. Outbound + inbound AI voice calls powered by ElevenLabs agents and Twilio, with full lead management, scoring, callbacks, DNC, analytics, costs, and integrations with Calendly and Close.

This document is the source of truth. Hand it to Claude Code phase by phase, not all at once.

---

## Table of contents

1. Tech stack
2. Branding & roles
3. Core data model
4. The List → Campaign → Number relationship
5. Pages
6. Inbound call routing
7. Dialer engine
8. Outcomes & retry rules
9. ElevenLabs integration
10. Twilio integration
11. Calendly integration
12. Close integration
13. OpenAI integration (rolling summary)
14. Public API
15. Cost tracking
16. Auth & security
17. Build order
18. Testing strategy
19. Design system

---

## 1. Tech stack

- **Frontend & hosting:** Next.js (App Router, TypeScript) on Vercel
- **Database, auth, storage, realtime:** Supabase (Postgres + RLS + Storage + Edge Functions)
- **Voice AI:** ElevenLabs Agents (TTS, STT, LLM, agent runtime, post-call data extraction, success evaluation, knowledge base)
- **Telephony:** Twilio (numbers, voice, lookup, recordings, status webhooks)
- **CRM email gateway:** Close (outbound emails + inbound reply webhook)
- **Appointments:** Calendly (event sync via webhook + OAuth)
- **Rolling summary LLM:** OpenAI (merges per-call summaries into a rolling lead context)
- **E2E testing:** Playwright
- **Source control & deploy:** GitHub CLI + Vercel CLI
- **AI scaffolding:** Claude Code + Superpowers

---

## 2. Branding & roles

**App name:** Smile & Dial
**Branding:** wordmark only, no logo for v1. Designer's choice on palette and typography, with a strict rule of consistency — one palette, one type scale, one spacing scale, one component library, used everywhere.

**Roles:**
- **Admin** — full workspace access, manages users, integrations, Twilio numbers, campaigns, agents, custom fields, lists, email templates, cost rates, sees System Health
- **Member** — sees and edits only their own leads, calls, callbacks, campaigns. No access to System Health, user management, integrations, Twilio number management, custom field definitions

Auth: Supabase Auth, email + password. No public signup. Admin invites users by email. 30-day idle session. No 2FA.

In-app notifications: a Member is notified when one of their leads hits Goal Met, and when a lead they own replies to a sent email.

---

## 3. Core data model

Member RLS applies on every owned resource: `owner_id = auth.uid()`. Admin RLS bypasses ownership.

### profiles
- `id` (FK to auth.users)
- `full_name`, `email`, `avatar_url`
- `role` (`admin` | `member`)
- `last_login_at`
- `active` (boolean)
- `notify_on_goal_met` (boolean, default true)
- `notify_on_email_reply` (boolean, default true)
- `created_at`

### lists
- `id`, `owner_id`
- `name`, `description`
- `created_at`
- Computed: lead count, current campaign attachment (if any)

A List is the unit that gets attached to a campaign. Every lead belongs to exactly one List.

### custom_field_defs
Admin-defined fields appended to every lead.
- `id`, `name`, `slug` (auto), `type` (`text` | `number` | `date` | `boolean` | `select`)
- `options` (JSONB, for select)
- `required`, `order`
- `created_at`

### leads
- `id`, `owner_id`
- `list_id` (FK, required — every lead is in a list)
- `company`
- `status` (see Section 8 enum)
- `last_outcome` (see Section 8 enum)
- `category` (text)
- `city`, `state`, `timezone` (auto-detected: state → city → area code of business_phone)
- `website`, `google_place_id`, `google_reviews`, `google_rating`
- `utm_campaign` (overwritten with the most recent campaign that called this lead)
- `business_phone` (E.164, unique within `owner_id`)
- `business_email` (auto-populated from call extraction if empty, manually editable)
- `owner_name`, `owner_phone` (owner_name auto-populated from call extraction if empty)
- `manager_name` (auto-populated from call extraction if empty)
- `employee_name` (auto-populated from call extraction if empty)
- `ai_summary` (text — rolling summary fed to agent as dynamic variable on next call)
- `conversations` (computed — count of calls with talk_time > 60s)
- `call_attempts` (computed — total call count)
- `last_call_at` (computed)
- `next_call_at` (timestamp — drives dialer)
- `resting_until` (timestamp — if status = Resting)
- `retry_counter` (unified counter for the 2d/2d/15d escalation, see Section 8)
- `retry_position` (which step of the cycle: 0 | 1 | 2)
- `deleted_at` (soft delete)
- `created_at`, `updated_at`

### lead_custom_values
- `lead_id` (FK), `custom_field_id` (FK), `value` (JSONB)

### campaigns
- `id`, `owner_id`
- `name`, `description`
- `status` (`active` | `paused` | `ended`)
- `agent_id` (FK to our `agents` table)
- `twilio_number_id` (FK, nullable — one number per campaign)
- `goal_id` (FK)
- `email_template_id` (FK, nullable)
- `calendly_event_id` (FK, nullable)
- `transfer_destination_phone` (E.164, nullable — if set, agent gets `transfer_to_number` tool)
- `calling_hours_start` (default 09:00)
- `calling_hours_end` (default 21:00)
- `calls_per_hour_cap`
- `calls_per_day_cap`
- `concurrency_cap_per_user` (1–5, ceiling 5)
- `daily_spend_cap` (USD, optional)
- `monthly_spend_cap` (USD, optional)
- `created_at`, `ended_at`

### list_campaign_attachments
A List can be attached to exactly one active campaign at a time. A campaign can have many Lists attached.
- `id`
- `list_id` (FK, unique constraint when active)
- `campaign_id` (FK)
- `attached_at`, `detached_at` (null when active)

### goals
- `id`, `owner_id`
- `name`, `description`
- `is_default` (boolean — seeded with "Schedule appointment")
- `created_at`

### agents
Our copy of the agent config; mirrored to ElevenLabs.
- `id`, `owner_id`
- `name`
- `elevenlabs_agent_id` (the synced ID on ElevenLabs side)
- `voice_id`
- `ai_model` (e.g. `gpt-4o`, `claude-sonnet-4`, `gemini-2.5-flash`)
- `system_prompt` (the assembled 6-block prompt — see Section 9)
- `prompt_personality`, `prompt_environment`, `prompt_tone`, `prompt_goal`, `prompt_guardrails` (raw inputs from wizard, kept for re-editing)
- `tools_enabled` (JSONB: `send_email`, `schedule_callback`, `get_available_times`, `book_appointment`, `mark_dnc`, `transfer_to_number`)
- `knowledge_base_ids` (array of FKs)
- `created_at`, `updated_at`

### knowledge_bases
- `id`, `owner_id`
- `name`, `description`
- `elevenlabs_kb_id`
- `created_at`

### knowledge_base_sources
- `id`, `kb_id` (FK)
- `type` (`file` | `url`)
- `file_path` (Supabase Storage path) or `url`
- `synced_at`

### twilio_numbers
Workspace-wide pool.
- `id`
- `phone_number` (E.164)
- `friendly_name`
- `country` (US | CA)
- `monthly_cost`
- `attached_campaign_id` (FK, nullable — when null, number is in pool)
- `purchased_at`, `released_at`
- `last_connect_rate_check_at` (for auto-rotation)
- `last_calls_count_24h`
- `last_connect_rate_24h`
- `flagged_for_rotation` (boolean)

### calls
- `id`
- `lead_id` (FK)
- `campaign_id` (FK)
- `agent_id` (FK)
- `twilio_number_id` (FK)
- `direction` (`inbound` | `outbound`)
- `status` (`queued` | `dialing` | `ringing` | `in_progress` | `completed` | `failed` | `cancelled`)
- `outcome` (see Section 8 enum, nullable until set)
- `outcome_source` (`twilio` | `elevenlabs` | `manual`)
- `goal_met` (boolean)
- `started_at`, `answered_at`, `ended_at`
- `duration_seconds`, `talk_time_seconds`
- `recording_path` (Supabase Storage path)
- `transcript_json` (JSONB — turn-by-turn `[{role, text, started_at, ended_at}]`)
- `summary` (text — per-call summary from ElevenLabs)
- `score` (numeric — from ElevenLabs success evaluation)
- `extracted_data` (JSONB — ElevenLabs Data Collection output)
- `twilio_call_sid` (unique)
- `elevenlabs_conversation_id` (unique)
- `cost_breakdown` (JSONB: `{twilio, elevenlabs, openai, lookup, total}`)
- `created_at`

### callbacks
- `id`, `lead_id`, `campaign_id`, `originating_call_id`
- `scheduled_at`
- `status` (`pending` | `completed` | `missed` | `cancelled`)
- `created_by` (user id, nullable when auto-created by agent)
- `result_call_id` (FK to the call that fulfilled it)
- `created_at`

### dnc_entries
Workspace-global.
- `id`, `phone` (E.164, unique)
- `company_snapshot`
- `reason` (`dnc_requested` | `invalid_number` | `language_barrier` | `manual` | `imported`)
- `added_by_user_id` (nullable)
- `source_call_id` (FK, nullable)
- `added_at`

### dnc_removals
Audit log of DNC removals.
- `id`, `phone`, `removed_by_user_id`, `reason_text`, `removed_at`

### email_templates
- `id`, `owner_id`, `name`, `subject`, `body_html`, `body_text`, `created_at`

### emails
- `id`, `lead_id`, `campaign_id` (nullable)
- `direction` (`sent` | `received`)
- `template_id` (FK, nullable)
- `subject`, `body`, `from_address`, `to_address`
- `close_message_id`
- `triggered_by_call_id` (FK, nullable)
- `sent_at` / `received_at`

### calendly_events
- `id`, `lead_id` (nullable, matched by invitee email/phone)
- `campaign_id` (nullable)
- `calendly_event_id`, `event_name`
- `scheduled_start`, `scheduled_end`
- `invitee_name`, `invitee_email`, `invitee_phone`
- `status` (`scheduled` | `canceled` | `rescheduled`)
- `goal_status` (`scheduled` | `attended` | `no_show` | `sale` | `closed`)
- `goal_status_notes`
- `created_at`

### api_keys
- `id`, `owner_id`, `name`
- `key_hash` (bcrypt)
- `key_prefix` (first 8 chars for display)
- `created_at`, `last_used_at`, `revoked_at`

### system_events
- `id`, `type`, `severity` (`info` | `warn` | `error`)
- `message`, `payload` (JSONB)
- `related_call_id`, `related_campaign_id` (nullable FKs)
- `created_at`

### notifications
- `id`, `user_id`, `type` (`goal_met` | `email_reply` | `campaign_paused_budget` | `number_flagged`)
- `payload` (JSONB)
- `read_at`, `created_at`

---

## 4. The List → Campaign → Number relationship

This is the heart of the data model. Get it right and everything else clicks.

**Rules:**
- Every lead belongs to exactly one List
- A List is attached to at most one active Campaign at a time
- A Campaign can have one or more Lists attached
- A Campaign has exactly one Twilio number attached (1:1, exclusive)
- A Twilio number is attached to at most one Campaign (or is in the pool)

**Why this matters:**
- The dialer finds dialable leads by: `lead.list.attached_campaign_id IS NOT NULL AND campaign.status = 'active' AND lead.status = 'ready_to_call' AND lead.next_call_at <= now()`
- Outbound dials go through the campaign's attached Twilio number
- Inbound on a Twilio number routes to the agent of whichever campaign it's attached to (deterministic, no fallback logic needed)
- If a number is not attached (in pool), Twilio plays "this number is not in service"

**Moving Lists between campaigns** (admin action):
- From the campaign settings, admin can detach a List
- From a List's row, admin can attach it to a different active campaign
- When detached, the List's leads stop being dialed until reattached
- When a campaign is **Ended**:
  - Admin chooses: (a) just detach all Lists, or (b) move all Lists to another campaign now
  - All pending Callbacks stay alive — they fire at scheduled time using the original ended campaign's agent
  - Resting timers persist
  - The Twilio number gets detached from the campaign and returns to the pool

**Note:** "Ended" campaigns become read-only. Their calls, leads, and analytics stay visible everywhere. No "Archived" state.

---

## 5. Pages

All list pages share a pattern:
- Top: search bar (where applicable), filters, saved views dropdown, bulk-action bar (visible when rows selected)
- Right side: column picker, export, import (Leads + DNC only)
- Body: sortable, paginated table
- Row click opens a right-side slide-in modal (~640px wide), same modal style across all pages

### 5.1 Leads

**Search:** company, business_phone, business_email

**Filters:** all lead fields including custom fields, list, status, last_outcome, date ranges (created_at, last_call_at, next_call_at)

**Columns (pickable, with defaults):** company, business_phone, business_email, status, last_outcome, list, city, state, conversations, call_attempts, last_call, next_call, owner

**Saved views:** private per user; named filter + column combos

**Bulk actions:** add to list, change list, add to DNC, reassign owner (admin only), delete (soft), export selected

**Import (CSV):**
- Map columns to fields
- Add new custom fields during import
- **Twilio Lookup runs on every row's business_phone** (US/CA only)
  - Mobile numbers are skipped entirely for TCPA compliance
  - VoIP numbers are allowed
  - Failed lookups (invalid format, disconnected) are skipped
  - Lookup cost (~$0.005/row) logged to Costs page under "Lookups"
- Skipped rows go into a downloadable error report (CSV with phone + reason)
- Dedup by business_phone within owner: skip / update / create-duplicate (user picks at import time)
- Auto-detect timezone from state → city → area code
- Optionally assign all imported leads to a List (required — every lead must have a List)
- Import summary shown before commit: "Importing N leads, skipping M mobile, K invalid. Cost ~$X for lookups. Proceed?"

**Export (CSV):** respects current filters + visible columns

**Lead detail modal:**
- All fields editable, autosave on blur
- Custom field values editable
- "Campaigns" section: shows the lead's List, which campaign that List is currently attached to, status, retry counter, resting_until, next_call_at
- "AI Summary" section: read-only rolling summary
- Activity timeline (right pane):
  - Imported (with source)
  - Call made (clickable → opens Call modal) with campaign name
  - Outcome logged
  - Callback scheduled / fulfilled / missed
  - Added to DNC / removed from DNC
  - Email sent / received (clickable → opens email body)
  - Manual edit (which field, by whom)
- "Call Now" button: choose campaign (must be active with this lead's List attached), then dial immediately. Still respects DNC + calling hours + concurrency cap (blocks with a message if any fails).
- "Merge into existing lead" button — only visible if the lead was auto-created from inbound

### 5.2 Calls

**Filters:** campaign, agent, direction, date range, status, outcome, goal_met, duration range, owner, has_callback, list, lead company

**Columns (pickable):** company, phone, campaign, agent, direction, started_at, duration, talk_time, status, outcome, goal_met, score, cost, has_recording

**Saved views:** same pattern

**Call detail modal:**
- Header: company (link to lead), campaign, agent, direction, started/ended, duration, talk_time
- Audio player: waveform, scrub, speed, download
- Transcript pane: turn-by-turn, click a line to jump audio to that timestamp
- Goal Evaluation block: pass/fail + reasoning (from ElevenLabs)
- Extracted Data block: all fields ElevenLabs Data Collection captured
- Summary (per-call)
- Outcome with manual override dropdown (logs change to system_events)
- Score
- "Schedule callback" button: opens small form (date, time)

**Cost is NOT shown in this modal** (lives on Costs page).

### 5.3 Callbacks

**Filters:** date range, campaign, status

**Columns:** company, phone, scheduled_at, status, created_by, created_at, campaign

**Callback modal:**
- Scheduled time (lead-local + viewer-local display)
- Who scheduled it (call link if auto)
- Lead snapshot + link to lead
- Buttons: Reschedule, Cancel, Call Now

**Auto-dial behavior:**
- System dials at `scheduled_at` using the original campaign's agent + Twilio number
- Callbacks can be set **outside calling hours** (lead's request wins)
- **Callback voicemail special case:** 1st VM → +30 min → 2nd VM → next day same time → 3rd VM → Resting 15d

### 5.4 Goals

Single page tracking outcomes of "Goal Met" leads as they progress through real-world status.

**Layout:** one section per campaign with at least one Goal Met lead. Each section shows the goal name and a table.

**Columns:** company, contact, scheduled appointment time (from Calendly), with-whom (from Calendly), goal_status (`scheduled` | `attended` | `no_show` | `sale` | `closed`), notes

**Status transitions:**
- `scheduled` — auto-set when a matching Calendly event arrives
- `attended` | `no_show` | `sale` | `closed` — manual by lead owner

**Filters:** campaign, date range, goal_status
**Sort:** default by scheduled appointment time

**Goal creation:** modal from a button at top of Goals page. Fields: name, description, is_default toggle. Default "Schedule appointment" is seeded on first deploy.

### 5.5 Campaigns

**List columns:** name, status, agent, twilio_number, lists count, calls today, goal_met today, goal_met all-time, spend today, spend all-time, owner

**Actions:** create, edit (modal), pause/resume, end, clone (copies settings except agent + number — those re-selected)

**Campaign settings modal** (tabbed because there's a lot):
- **General:** name, description, owner, status display, daily_spend_cap, monthly_spend_cap
- **Agent:** pick existing agent (built in this app), link by ElevenLabs agent ID, or build new (opens Agent Builder wizard — see Section 9)
- **Telephony:** twilio_number (attach from pool — only shows unattached numbers + this campaign's current one), calling_hours_start, calling_hours_end, calls_per_hour_cap, calls_per_day_cap, concurrency_cap_per_user
- **Tools:**
  - Calendly event dropdown (only if Calendly connected; lists events from connected account)
  - Email template dropdown (only if Close connected and template exists)
  - Transfer destination phone (E.164 input — when set, agent gets `transfer_to_number` tool)
- **Knowledge base:** multi-select from knowledge_bases
- **Goal:** dropdown from goals table
- **Lists:** multi-select of lists to attach to this campaign (only shows currently-unattached lists + this campaign's current ones)
- **Test:** browser-based test call — start a WebSocket session to ElevenLabs and talk to the agent through your laptop mic/speakers. No phone number needed.

**Pause:** stops new dials, in-progress calls finish
**End:** modal asks (a) just detach Lists, or (b) move them to a destination campaign now. Twilio number goes back to pool.

### 5.6 Analytics

**Slicers:** campaign, user, list, date range
**Date range presets:** today, yesterday, last 7d, last 30d, this month, last month, custom
**Compare periods:** toggle showing "this period vs previous period" deltas on every KPI

**KPI tiles:**
- Total calls
- Conversations (>60s talk time)
- DMs Reached (calls where outcome implies talked to decision-maker — defined as outcome in [`goal_met`, `not_interested`, `callback`, `dnc`, `transferred_to_human`])
- Connect rate
- Goal Met count
- Goal Met rate (% of conversations that hit goal)
- Avg call duration
- Avg cost per call
- Cost per Goal Met
- Callbacks scheduled
- DNC additions
- Appointments attended
- Sales closed

**Charts:**
- Calls over time (line, daily/weekly/monthly toggle)
- Outcome distribution (donut)
- Funnel: Dialed → Connected → Conversation → DMs Reached → Goal Met → Attended → Sale
- Cost over time (line)
- Best performing campaigns (bar, sortable by Goal Met count or Cost per Goal Met)

No export, no search.

### 5.7 DNC

Workspace-global. **Enforced at dial time.**

**Filters:** reason, date range
**Columns:** company, phone, reason, added_by, source_call (link), added_at
**Bulk actions:** export selected, remove from DNC (admin only — opens modal requiring reason text, logs to `dnc_removals`)

**Manual add:** form with phone + reason + optional company

**Import (CSV):** phone column required, reason defaults to `imported`

### 5.8 Costs

**No manual rate configuration.** All costs pulled from vendor APIs and stored on the call's `cost_breakdown` JSON:
- Twilio per-call cost from Twilio API
- ElevenLabs cost from post-call webhook
- OpenAI cost from API response (for rolling summary merge)
- Twilio Lookup cost logged at import time

**Views (toggle at top):**
- Per call (drill-in opens call modal)
- Per campaign (total + per-call avg + cost per goal met)
- Per goal met (cost per acquisition by campaign)
- Per user (total spend by user)
- Per day / week / month (time series)
- Per vendor (stacked bar)

**Budget alerts:**
- `daily_spend_cap` and `monthly_spend_cap` configured per campaign
- When hit: in-app notification to owner, auto-pause campaign, system_event logged
- Admin can resume past the cap (override)

### 5.9 Settings

Tabbed page.

**Profile (all users):** name, avatar, password, notification preferences

**Users (admin only):** list users, invite by email, change role, deactivate/reactivate, force password reset

**Twilio numbers (admin only):**
- Table: phone, friendly_name, country, monthly_cost, attached campaign, status, 24h connect rate, flagged
- Buy new number (modal with country + area code search via Twilio API)
- Release number (blocked if has in-progress calls; warns if currently attached to a campaign)
- "Release & Replace" quick action on flagged numbers

**Integrations (admin only):**
- Calendly: OAuth connect, last sync time, "Sync now" button, list of synced event types
- Close: API key or OAuth connect, last activity timestamp
- ElevenLabs: API key, allowed voice IDs (comma-separated, populates voice dropdown in Agent Builder)

**Email templates:** CRUD; list with name, subject, last used; template variable picker in editor (see Section 12)

**Custom fields (admin only):** CRUD with reorder; delete warns if data exists

**Lists:** CRUD; delete only removes label (leads stay); blocked if List is currently attached to an active campaign

**Goals:** CRUD; default flag; can't delete if in use

**Knowledge bases:** CRUD; upload files, paste URLs, view sync status

**Agents:** CRUD list of all agents built in the app; edit reopens Agent Builder wizard (changes are live — see Section 9)

**API (admin only):**
- Create key: name input → key shown once, copy-to-clipboard
- List active keys with prefix + last_used + revoke button
- **Inline documentation panel:** endpoint URL, headers, body schema, response examples, curl example. See Section 14.

### 5.10 System Health (admin only)

Chronological log of `system_events`. Auto-refresh every 10s with pause toggle.

**Columns:** timestamp, type, severity, message, related_call (link), related_campaign (link), expand for raw payload
**Filters:** severity, type, date range

Surfaced events include: Twilio errors, ElevenLabs errors, webhook errors, dialer failures, orphan calls (Twilio ended but no ElevenLabs payload after 5 min), flagged numbers, budget caps hit, integration disconnects.

---

## 6. Inbound call routing

Deterministic and simple now that numbers are 1:1 with campaigns.

1. Inbound call arrives at Twilio number N
2. Look up which campaign N is attached to
3. If attached → route to that campaign's agent (ElevenLabs picks up)
4. If not attached → Twilio plays "this number is not in service"
5. Look up caller's phone in leads (within the campaign's owner's leads):
   - **Match** → attach call to that lead, direction = inbound, preserve all extracted data and pass `ai_summary` to the agent as dynamic variable
   - **No match** → create a new lead in a system-managed "Inbound" List under the campaign's owner, with phone + timestamp. Let ElevenLabs Data Collection populate name/email/company during the call.
6. Auto-created inbound leads get a "Merge into existing lead" button in their modal — owner or admin can merge data into a pre-existing lead

---

## 7. Dialer engine

The dialer is a Supabase Edge Function on a 30-second cron tick.

**On each tick:**

1. Query for dialable leads:
   - `lead.list.attached_campaign_id IS NOT NULL`
   - `campaign.status = 'active'`
   - `lead.status = 'ready_to_call'`
   - `lead.next_call_at <= now()`
   - `lead.business_phone NOT IN (SELECT phone FROM dnc_entries)` (DNC check at query time)
   - Within calling hours for lead's timezone (9am–9pm local by default, configurable per campaign)
   - Campaign hasn't hit calls_per_hour_cap (rolling 60min window)
   - Campaign hasn't hit calls_per_day_cap (rolling 24hr window)
   - Campaign hasn't hit daily_spend_cap or monthly_spend_cap
   - Lead owner's concurrency count < their cap

2. **Pre-call check (final verification before dialing):**
   - Lead still not on DNC
   - Still within calling hours
   - Campaign still active
   - Spend cap still not exceeded
   - User concurrency cap still not hit
   - Twilio number still attached and not flagged

3. If any pre-call check fails → abort dial, bump `next_call_at` to next eligible window, no outcome logged

4. If all pass → fire Twilio outbound call connected to ElevenLabs Conversational AI, passing:
   - `agent_id` = campaign.agent's elevenlabs_agent_id
   - `agent_phone_number_id` = campaign's Twilio number's elevenlabs phone number ID
   - Dynamic variables: `lead_first_name`, `lead_company`, `lead_context` (= lead.ai_summary), plus any custom fields the agent needs

**Out-of-hours handling:** when a lead becomes eligible by `next_call_at` but it's outside their local calling hours, the dialer skips them and bumps `next_call_at` to the next 9am local time.

**Manual "Call Now":** bypasses queue but still respects all pre-call checks. Blocks with a message if any check fails (e.g. "You're at concurrency cap — finish a current call first").

**Inbound FIFO + API FIFO:** calls and lead-creation requests via the public API are processed in arrival order. Same applies to callback dial times — earliest wins, ties slip by 1 minute.

**Idempotency:**
- Twilio webhooks deduped by `CallSid + EventType`
- ElevenLabs webhooks deduped by `conversation_id + event_type`
- Public API supports an `Idempotency-Key` header for safe retries

**Orphan call detection:** if a call sits in `completed` status with no ElevenLabs post-call payload after 5 minutes, write a `system_event` for admin to investigate.

---

## 8. Outcomes & retry rules

### Status enum (on `leads`)
- `ready_to_call`
- `callback`
- `resting`
- `goal_met` (terminal for the lead's current List–campaign assignment; lead can be moved to a new List/campaign by admin later)
- `attended`, `no_show`, `closed`, `sale` (these are `goal_status` on the calendly_events row, not on the lead, but the lead's status display reflects them)
- `dnc` (terminal)
- `email_replied` (paused dialing; lead replied via Close; can still be manually called)

### Outcome enum (on `calls`)

**Twilio-detected (auto):**
- `voicemail`
- `no_answer`
- `busy`
- `failed`
- `hung_up_immediately` (answered, hung up <5s)
- `invalid_number`

**ElevenLabs-extracted (auto via Data Collection field `disposition`):**
- `gatekeeper`
- `not_interested`
- `callback`
- `dnc`
- `goal_met`

**Manual (user sets via call modal override):**
- `language_barrier`
- `ai_receptionist`
- `ai_error`
- `transferred_to_human`

### Retry rules

The **unified retry counter** increments on any of: voicemail / no_answer / busy / failed / hung_up_immediately / gatekeeper / ai_error.

The counter drives a 3-step cycle:
- Position 0 → push next_call_at by **2 days**
- Position 1 → push by **2 days**
- Position 2 → push by **15 days**, then reset position to 0 (cycle loops forever)

| Outcome | Counter behavior | next_call_at | Status set | Side effects |
|---|---|---|---|---|
| voicemail | increment unified | per cycle | ready_to_call | — |
| no_answer | increment unified | per cycle | ready_to_call | — |
| busy | increment unified | per cycle | ready_to_call | — |
| failed | increment unified | per cycle | ready_to_call | — |
| hung_up_immediately | increment unified | per cycle | ready_to_call | — |
| gatekeeper | increment unified | per cycle | ready_to_call | — |
| ai_error | increment unified | per cycle | ready_to_call | system_event logged |
| invalid_number | n/a | null | dnc | auto-add to DNC with reason `invalid_number` |
| not_interested | reset to 0 | now + 30d | resting (resting_until = now + 30d) | — |
| ai_receptionist | reset to 0 | now + 15d | resting | — |
| language_barrier | n/a | null | dnc | auto-add to DNC with reason `language_barrier` |
| dnc | n/a | null | dnc | auto-add to DNC with reason `dnc_requested` |
| callback | n/a | scheduled time | callback | create callback row |
| goal_met | n/a | null | goal_met | terminal for this list-campaign |
| transferred_to_human | n/a | null | goal_met (effectively) | — |

**Callback voicemail special case** (only when dialing a scheduled callback):
- 1st VM at callback → push 30 min, retry
- 2nd VM → schedule next day same time
- 3rd VM → Resting 15 days, callback marked `missed`

**Resting expiry:** a nightly Supabase function flips `status` from `resting` to `ready_to_call` and sets `next_call_at = now()` for any lead whose `resting_until < now()`.

---

## 9. ElevenLabs integration

### Agent Builder wizard

Wizard flow (Settings → Agents, or "Build new" from campaign modal):

**Step 1 — Basics:**
- Name
- Voice (dropdown from admin's allowed voice IDs, with preview audio)
- AI model (full list from ElevenLabs supported models)

**Step 2 — Personality:** "How would you describe this agent's personality? (e.g., friendly and curious, professional and direct)" → free text 1–3 sentences

**Step 3 — Environment:** "Where is this agent operating? (e.g., outbound phone calls to small business owners during business hours)" → free text 1–2 sentences

**Step 4 — Tone:** "How should the agent speak? (e.g., concise, 2-3 sentences max, brief affirmations like 'I see' or 'Got it')" → free text + checkboxes for common patterns

**Step 5 — Goal:** "What is the agent trying to accomplish?" → free text + numbered steps the agent should follow

**Step 6 — Guardrails:** "What should the agent never do? (e.g., never promise pricing, never disclose company financials, escalate if customer becomes abusive)" → free text bullet list

**Step 7 — Tools:** checkboxes for which tools to enable (any tool selected here must be configurable on the campaign that uses this agent; the campaign settings determine the actual config):
- `send_email` (requires email_template + Close)
- `schedule_callback`
- `get_available_times` (requires Calendly event)
- `book_appointment` (requires Calendly event)
- `mark_dnc`
- `transfer_to_number` (requires `transfer_destination_phone` set on the campaign)

**Step 8 — Knowledge base:** multi-select from workspace knowledge_bases

**Step 9 — Review:** assembled system prompt shown in full, editable. Admin can tweak any section directly. Save → pushes to ElevenLabs via API, stores `elevenlabs_agent_id`.

### Assembled prompt structure (the 6-block ElevenLabs standard)

```
# Personality
{prompt_personality}

# Environment
{prompt_environment}

# Tone
{prompt_tone}

# Goal
{prompt_goal}

# Guardrails
{prompt_guardrails}

# Tools

## send_email
**When to use:** When the lead requests information by email during the call, or asks to be sent details.
**How to use:**
1. Confirm the lead's email address by reading it back to them.
2. Call the tool with their confirmed email.
3. Tell them "I've sent that over — you should see it within a minute."

## schedule_callback
**When to use:** When the lead says they're busy now and asks to be called back at a specific time.
**How to use:**
1. Confirm the date and time clearly: "So that's Tuesday the 15th at 2 PM your local time, correct?"
2. Call the tool with the confirmed datetime in ISO 8601 format (e.g., "2026-01-15T14:00:00-06:00").

## get_available_times
**When to use:** When the lead expresses interest in scheduling a meeting and you need to offer specific time slots.
**How to use:** Call this tool to retrieve current availability, then offer 2–3 options to the lead.

## book_appointment
**When to use:** After the lead has chosen a specific time slot from the options you offered.
**How to use:**
1. Confirm the chosen time.
2. Call the tool with the slot ID and the lead's name and email.
3. Tell them they'll receive a calendar invite shortly.

## mark_dnc
**When to use:** When the lead explicitly asks to be removed from the calling list, or says "don't call me again."
**How to use:**
1. Confirm: "I understand, I'll make sure you're not contacted again."
2. Call the tool.

## transfer_to_number
**When to use:** When the lead asks to speak with a human, or when the conversation requires escalation beyond what you can handle.
**How to use:**
1. Tell the lead "Let me connect you with someone who can help."
2. Call the tool — the call will be transferred immediately.

# Lead context
Here's what we know about this lead from previous calls. Use this to avoid repeating yourself and pick up where the last conversation left off.

{{lead_context}}

If `{{lead_context}}` is empty, this is the first call with this lead — introduce yourself and the company normally.

# Tool error handling
If any tool fails:
1. Acknowledge: "I'm having trouble with that right now."
2. Do not guess or make up information.
3. Offer to follow up later or escalate.
```

### Data Collection configuration (set per agent at sync time)

ElevenLabs Data Collection extracts structured fields after each call. Configured automatically when we push the agent:

- `disposition` (enum): `gatekeeper` | `not_interested` | `callback` | `dnc` | `goal_met` — the agent's read on call outcome
- `business_email` (string): extracted if mentioned
- `owner_name` (string): extracted if mentioned
- `manager_name` (string): extracted if mentioned
- `employee_name` (string): extracted if mentioned
- `callback_datetime` (datetime): extracted when outcome is `callback`
- `objection_summary` (string): reason given when outcome is `not_interested`

### Success Evaluation

A single criterion tied to the campaign's goal — e.g. for "Schedule appointment": "Did the lead agree to a specific date and time for an appointment?" Result is pass/fail/unknown, stored in `calls.score`.

### Post-call webhook handler

Edge Function receives the webhook and writes:
- `outcome` from `disposition` data collection field (mapped to our enum)
- `transcript_json`
- `summary`
- `score`
- `extracted_data`
- `recording_path` (download + upload to Supabase Storage)
- `cost_breakdown.elevenlabs`
- Auto-populate lead fields (business_email, owner_name, manager_name, employee_name) **only if currently empty**
- Trigger the rolling summary merge (see Section 13)
- Apply retry rule to update lead status, retry_counter, next_call_at
- If outcome triggers DNC, insert into dnc_entries
- If outcome is `callback`, create callback row from `callback_datetime`
- If outcome is `goal_met`, notify the lead's owner

### Agent versioning

Edits to an agent overwrite the live ElevenLabs agent immediately (no version history). The edit screen shows a banner: "This agent is live in campaign(s) X, Y. Changes apply to the next call."

### Test call (browser-based)

In the campaign settings modal's "Test" tab, clicking "Test agent" opens a WebSocket session to ElevenLabs's conversation endpoint. Admin's mic streams in, agent's voice streams out. No phone, no Twilio, no real lead. Used to validate prompt changes before going live.

---

## 10. Twilio integration

### Number management
- Buy numbers from inside the app (Twilio Search API → purchase via API)
- US + Canada only
- Released numbers stay in our table with `released_at` set, for cost history
- Attaching a number to a campaign updates ElevenLabs to point that number's webhook at the right agent

### Outbound dialing
- Twilio Programmable Voice initiates outbound, then bridges to ElevenLabs's media stream
- We use ElevenLabs's outbound call API (`POST /v1/convai/twilio/outbound-call`) which takes `agent_id` + `agent_phone_number_id` + `to_number`
- Twilio status callbacks update `calls.status` in real time (queued → dialing → ringing → in_progress → completed)
- Twilio's per-call price endpoint is queried after call completion to populate `cost_breakdown.twilio`

### Inbound routing
- Each Twilio number's voice URL points to a Supabase Edge Function
- Edge Function looks up the number's `attached_campaign_id`, then forwards to the right ElevenLabs agent endpoint
- If number is unattached, return Twilio TwiML that plays "this number is not in service"

### Twilio Lookup (Line Type Intelligence)
- Run on every imported phone number
- Block lines where line_type = `mobile`
- Allow `landline`, `voip`, `fixedVoip`
- Cost (~$0.005 per lookup) logged at import time to `cost_breakdown.lookup` (these are batched under a synthetic "import" cost record on the Costs page)

### Auto-rotation flag
- Nightly job: for each number that's been used outbound that day, calculate connect rate (calls where outcome NOT in [voicemail, no_answer, busy, failed, invalid_number] divided by total outbound calls)
- If connect rate < 15% AND total calls today ≥ 300 → set `flagged_for_rotation = true`, send admin notification, write system_event
- Admin sees the flag in Settings → Twilio numbers and can click "Release & Replace" — releases the flagged number and opens the buy modal to purchase a replacement, automatically attaching to the same campaign

---

## 11. Calendly integration

- OAuth connect in Settings
- Webhook subscribes to `invitee.created`, `invitee.canceled`, `invitee.no_show`
- Sync also pulls available event types into a workspace list (for campaign settings dropdown)
- On `invitee.created`: write to `calendly_events`, match invitee email/phone to a lead (within the same owner), update lead's calendly link and trigger `goal_status = scheduled` on the Goals page
- On `invitee.canceled`: update `calendly_events.status`, set the Goals page goal_status to a state TBD (suggest: revert to no entry, with a note)
- If Calendly disconnected, the `get_available_times` and `book_appointment` agent tools are disabled for any campaign

---

## 12. Close integration

Close is purely the email gateway (no CRM sync of leads or calls — leads stay in Smile & Dial).

- Connect via API key or OAuth
- **Outbound emails**: when the agent triggers `send_email` (or admin sends manually from a lead's activity feed), we POST to Close's email send endpoint. Close sends the email from the configured Close user. Save `close_message_id` for thread linkage.
- **Inbound replies**: Close webhook on `email.received` → we match thread to our `emails` row → write a `direction=received` email row, attach to the lead, change lead status to `email_replied`, notify the owner

### Template variables

Supported in email_templates body and subject:
- `{{lead.company}}`, `{{lead.business_phone}}`, `{{lead.business_email}}`
- `{{lead.owner_name}}`, `{{lead.manager_name}}`, `{{lead.employee_name}}`
- `{{lead.city}}`, `{{lead.state}}`
- `{{lead.<custom_field_slug>}}` for any custom field
- `{{campaign.name}}`, `{{owner.full_name}}`
- `{{appointment.time}}`, `{{appointment.url}}` (if a Calendly event is linked)

Variable picker in template editor inserts these with a click.

---

## 13. OpenAI integration (rolling AI summary)

ElevenLabs returns a per-call summary in its post-call webhook. We need to merge these into a rolling lead summary that we feed back to the agent on the next call as `{{lead_context}}`.

### Approach

After each call, an Edge Function:
1. Pulls the lead's last 5 call summaries (most recent first)
2. Calls OpenAI with a tight prompt:

```
You are maintaining a running context note about a sales lead so that the next outbound call agent can pick up where the previous one left off.

Previous context note:
{existing_ai_summary}

Latest call summary:
{latest_call_summary}

Merge these into a single concise note (max 200 words) covering:
- What we know about the lead (name, role, company specifics)
- What they've said they want or don't want
- Any commitments made (callback, send info, etc.)
- Where the conversation left off

Write in the format "we know X / we last left off Y." No filler.
```

3. Writes the result to `lead.ai_summary`

### Cost

~$0.001 per call with `gpt-4o-mini`. Logged to `cost_breakdown.openai`.

### On the next outbound dial

`lead.ai_summary` is passed to ElevenLabs as a dynamic variable. The agent's system prompt has a `# Lead context` section that interpolates it.

---

## 14. Public API (inbound lead creation)

### Endpoint
`POST https://app.smileanddial.com/api/v1/leads`

### Headers
```
Authorization: Bearer <api_key>
Content-Type: application/json
Idempotency-Key: <optional-uuid-for-safe-retries>
```

### Body
```json
{
  "business_phone": "+18005551234",
  "company": "Acme Gym",
  "city": "Austin",
  "state": "TX",
  "business_email": "info@acmegym.com",
  "owner_name": "Pat Smith",
  "owner_phone": "+15125559876",
  "list": "January Partner Imports",
  "custom_fields": {
    "referrer_source": "Partner X",
    "tier": "gold"
  }
}
```

### Response
- **201 Created** with the created lead, OR
- **200 OK** with the existing lead (if dedup matched within the API key owner's leads)
- **400** for validation errors
- **403** for invalid/revoked key
- **422** with `{ "error": "phone_is_mobile_blocked" }` if Twilio Lookup classifies as mobile

### Notes
- API keys are scoped to a single user; the created lead's `owner_id` = that user
- The `list` field must exist (or be omitted; if omitted, lead goes into a default "API Inbound" list per owner)
- Twilio Lookup is NOT run for API-created leads (the docs note this is because external systems have already collected consent)
- Created leads go straight into the dialer queue if the List is attached to an active campaign

### Inline docs

The Settings → API panel renders the above as readable docs with a curl example and a "Try it" button.

---

## 15. Cost tracking

**No manual rate configuration.** Costs are pulled from APIs on a per-event basis.

Per call, the `cost_breakdown` JSON looks like:
```json
{
  "twilio": 0.0125,
  "elevenlabs": 0.0480,
  "openai": 0.0009,
  "lookup": 0,
  "total": 0.0614
}
```

Twilio Lookup costs are recorded at import time and attributed to:
- The user who ran the import
- Not to any specific call or campaign (they appear under "Lookups" in the per-vendor view)

The Costs page aggregates these. Budget caps (daily / monthly per campaign) are evaluated by summing `cost_breakdown.total` over the relevant time window for all calls in that campaign.

When a cap is hit:
- Campaign auto-pauses
- Owner gets an in-app notification
- system_event written
- Admin can resume past the cap

---

## 16. Auth & security

- Supabase Auth with email + password
- 30-day idle session
- No 2FA in v1
- No public signup; admin invites by email
- RLS on every owned table: members see/edit only `owner_id = auth.uid()`, admins bypass
- Sensitive workspace settings (integrations, Twilio numbers, users, custom field defs, API keys) gated by admin role check at both the API layer and RLS layer
- API keys hashed with bcrypt; raw key shown exactly once on creation
- Webhook endpoints (Twilio, ElevenLabs, Calendly, Close) verify signatures
- Soft delete for leads (recoverable by admin for 30 days from a "Deleted leads" admin view; hard purge job after 30 days)
- Recording + transcript retention: 5 years minimum (storage cost noted)

---

## 17. Build order

38 steps grouped into 9 phases. Each step = one PR, with at least one Playwright test, deployed to Vercel preview, approved before moving on.

### Phase 1 — Foundation
1. Repo: Next.js (App Router, TypeScript), Tailwind, shadcn/ui, ESLint, Prettier, Husky. Push to GitHub. Connect to Vercel.
2. Supabase project: `profiles` table, basic auth (email/password, no signup), RLS policies, admin invite flow.
3. App shell: sidebar (Leads, Calls, Callbacks, Goals, Campaigns, Analytics, DNC, Costs, Settings; admin-only items hidden for members), top bar, notification bell, design tokens locked in.
4. Settings → Users (admin invite, role change, deactivate, force password reset).

### Phase 2 — Lead management
5. Lists CRUD page.
6. Custom fields CRUD admin page.
7. Leads table: all fields, search, filter bar, column picker, saved views, pagination.
8. Lead CSV import: column mapping, custom field creation, Twilio Lookup integration (block mobile), dedup logic, timezone auto-detection, error report export.
9. Lead CSV export (filtered + visible columns).
10. Lead detail modal: editable fields, custom field values, activity timeline, AI Summary section, Campaign/List section.
11. Bulk actions on Leads page.

### Phase 3 — Campaigns & telephony foundation
12. Goals CRUD page (seed "Schedule appointment" as default).
13. Knowledge bases CRUD in Settings (file upload to Supabase Storage; URL list).
14. Twilio numbers admin page: list, buy modal, release flow.
15. ElevenLabs voice ID configuration in Settings (admin pastes list).
16. Agent Builder wizard: 6-block prompt assembly, voice/model picker, tools selector, KB attachment, review/edit, push to ElevenLabs API, save `elevenlabs_agent_id`.
17. Agents CRUD list in Settings (edit reopens wizard, deletes if not in use).
18. Campaigns CRUD: list page, settings modal with all tabs (General, Agent, Telephony, Tools, KB, Goal, Lists, Test).
19. List ↔ Campaign attachment UI (multi-select in campaign modal + attach from List row).
20. DNC page: import, manual add, admin remove with reason logging, dial-time enforcement helper function.

### Phase 4 — The dialer
21. `dial_queue` view + 30-second cron Edge Function: query → pre-call checks → fire Twilio + ElevenLabs.
22. Twilio status webhook handler: update call status in real time, idempotency via `CallSid + EventType`.
23. ElevenLabs post-call webhook handler: write outcome, transcript, summary, recording, score, extracted data, cost; auto-populate empty lead fields; apply retry rule; insert DNC; create callback; trigger Goal Met notification.
24. Retry engine: unified counter logic, 2d/2d/15d cycle, status transitions, Resting expiry nightly job.
25. Spend cap monitor: cron job sums spend, auto-pauses campaign when cap hit, notifies owner.
26. Twilio number connect rate monitor: nightly job flags numbers < 15% over 300+ calls.

### Phase 5 — Calls & inbound
27. Calls page with filters, columns, saved views.
28. Call detail modal: audio player, transcript with timestamp jumps, override outcome, schedule callback from modal.
29. Inbound call routing Edge Function: number → campaign → agent; auto-create lead if no match; preserve `ai_summary` if match.
30. "Merge into existing lead" action on auto-created inbound leads.
31. Browser-based test call from campaign modal (WebSocket to ElevenLabs).

### Phase 6 — Follow-ups & goals
32. Callbacks page + auto-dial at scheduled time + callback voicemail special-case logic.
33. Goals page: per-campaign sections, scheduled/attended/no_show/sale/closed manual transitions; Calendly auto-fills scheduled.
34. "Call Now" from lead modal (respecting pre-call checks).

### Phase 7 — Reporting
35. Analytics page: KPI tiles, charts, funnel, slicers, compare periods.
36. Costs page: all 6 views (per call, per campaign, per goal met, per user, per time, per vendor) + budget cap configuration.

### Phase 8 — Integrations & polish
37. Calendly OAuth + event sync + invitee matching; agent tool wiring (get_available_times, book_appointment).
38. Close integration: outbound `send_email` agent tool, inbound webhook for replies, email template variables, lead status change to `email_replied`.
39. OpenAI rolling summary merge Edge Function.
40. In-app notifications (bell + dropdown): Goal Met, email reply, campaign paused (budget), number flagged.
41. Public API + API key UI + inline docs.
42. System Health page.

### Phase 9 — QA & launch
43. Full Playwright regression suite pass.
44. Soft-launch load test: 50 simulated concurrent outbound calls.
45. First real campaign dry-run with admin oversight.

---

## 18. Testing strategy

**Playwright E2E (runs on every PR against Vercel preview):**
- Auth: login, logout, invite member, role-based access (member tries to see admin pages → blocked)
- Leads: create, import 100-row CSV with Twilio Lookup mocked (some mobile, some valid), filter, save view, export, edit in modal, bulk add to list
- Custom fields: admin creates field → appears in import + lead modal + filter
- Lists: create, attach to campaign, detach
- Campaigns: create with agent + Twilio number, link Calendly event, link email template, link KB; pause/resume; end with "move lists to other campaign"; clone
- Agent builder: walk through 6-step wizard, assert assembled prompt has all 6 sections
- DNC: import, manual add, admin removal (logs to dnc_removals), dial-time enforcement check (mocked Twilio)
- Calls: modal renders transcript + audio + extracted data + score; override outcome; schedule callback
- Callbacks: auto-dial fires at scheduled time (with time mocks); callback voicemail escalation works (1st VM → 30min → 2nd VM → next day → 3rd VM → Resting)
- Outcome engine: feed synthetic ElevenLabs webhook payloads for each outcome, assert next_call_at, status, retry counter, side effects (DNC insertion, callback creation, notification)
- Inbound: simulated Twilio inbound webhook → matches existing lead → creates call with direction=inbound; unmatched → creates new inbound lead
- API: create key, POST lead, assert dedup, assert mobile rejection
- RLS: member cannot read/edit another member's leads/calls/campaigns
- Costs: webhook payload writes cost_breakdown; budget cap triggers auto-pause + notification
- Calendly: simulated invitee.created webhook → matches lead → Goals page shows scheduled
- Close: simulated inbound email webhook → email row created → lead status = email_replied → owner notified

**Manual smoke tests** (run before each real-money phase):
- Real outbound call to a test number with a real agent
- Real inbound call
- Real Calendly booking
- Real Close email round-trip

**CI:** GitHub Actions runs Playwright on every PR.

---

## 19. Design system

These tokens get locked in Phase 1 step 3 (app shell) as CSS variables and Tailwind theme extensions. Never override inline. Never deviate page to page.

### Palette

Light theme primary tokens:
- **Primary (navy):** deep navy for primary buttons, active nav states, links. Approximate `#0F1E3D` for the base; lighter and darker shades generated via Tailwind's color scale.
- **Accent (coral):** warm coral for primary CTAs that need to pop, Goal Met indicators, and notification badges. Approximate `#FF6B5B`.
- **Surface (off-white):** soft off-white for page background, slightly lighter for cards. Approximate `#FAF9F7` for body, `#FFFFFF` for cards.
- **Text (charcoal):** near-black charcoal for body text, mid-gray for secondary text, light gray for placeholders. Approximate `#1A1D24` primary, `#5C6370` secondary.
- **Borders:** subtle warm gray. Approximate `#E5E2DC`.
- **Success:** muted green `#1F9D55` (call connected, goal met confirmation).
- **Warning:** amber `#D97706` (flagged numbers, approaching cap).
- **Error:** muted red `#DC2626` (failed calls, validation errors).

Dark theme: invert surfaces to deep neutrals (`#13151B` body, `#1C1F27` cards), keep navy and coral as accents, lighten text. Build both themes from the start; users get a theme toggle in their profile.

### Typography

- **UI font:** Inter, loaded from Google Fonts or self-hosted. Weights: 400, 500, 600, 700.
- **Monospace:** JetBrains Mono. Used for phone numbers, call IDs, API keys, code examples in the API docs panel, and anything else that benefits from fixed-width legibility.
- **Type scale (rem-based, 16px root):** 12 / 14 / 16 / 18 / 20 / 24 / 32. No other sizes.
- **Line heights:** 1.4 for body, 1.2 for headings, 1.5 for long-form prose.

### Spacing & layout

- **Base unit:** 4px. All spacing comes from the scale: 4, 8, 12, 16, 24, 32, 48, 64.
- **Border radius:** 8px on buttons, inputs, cards, badges. 12px on modals and slide-in panels. 9999px for circular avatars and pills.
- **Shadows:** subtle. One elevation for cards (`shadow-sm`), one for modals (`shadow-lg`), nothing in between unless absolutely needed.

### Components

Use shadcn/ui as the starting point. Customize once, then reuse. The full set v1 needs:

button, input, textarea, select, checkbox, radio, switch, table, modal, slide-in panel, badge, tabs, toast, dropdown, popover, tooltip, empty state, loading skeleton, alert, dialog, command palette (optional, nice-to-have for search), avatar, kbd.

### Patterns

- **Tables look identical** across Leads, Calls, Callbacks, DNC, Campaigns, Twilio numbers, Users — same row height (48px), same hover, same sort indicators, same selection checkbox style, same column-picker pattern.
- **Modals slide in from the right**, consistent 640px width, with a fixed header (title + close), scrollable body, and a fixed footer for actions when needed.
- **Empty states** always include an icon, a helpful message, and a primary action ("No leads yet → Import CSV").
- **Loading states** use skeletons for content, spinners only for inline button states.
- **Errors** use a toast pattern with icon + concise message + optional action link. Inline form errors show below the field in error color.
- **No emoji in UI text.**
- **Vibe:** calm, focused, professional. This is an operations dashboard for someone running serious outbound campaigns — not playful, not generic SaaS blue.
- **Tablet+ only.** No mobile responsive design.
