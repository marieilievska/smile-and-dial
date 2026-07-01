# Send a lead to a closer (push to Close) — Design

**Date:** 2026-07-01
**Status:** Design approved, pending spec review

## Problem

When the AI qualifies a lead — typically by booking the Zoom demo (`goal_met` /
`scheduled`, with a `calendly_events` row) — there is no way to hand that lead to
a human closer. Referrizer's closers work in **Close** (an external CRM), not in
Smile & Dial. Today a booked lead just sits at `goal_met`/`scheduled`; nobody on
the sales team is notified and none of the AI-gathered context (summary, who to
meet, lead response time, decision-maker, appointment, recording) reaches them.
We want an operator to hand a reviewed lead to Close with one click, carrying the
full context.

## Decisions (approved)

1. **Closer = external CRM: Close.** Handoff = push the lead + context into the
   owner's connected Close account. No in-app closer role or queue.
2. **Trigger = manual "Send to closer" button.** The operator reviews the lead
   and clicks to hand it off. Not automatic.
3. **Payload = rich handoff note + core contact fields.** Find/create the Close
   lead + contact (company, contact name, phone, email) and attach ONE
   note/activity carrying the context.
4. **Post-handoff = log only, change nothing.** Record who/when; the lead's
   status and dialer eligibility are untouched; re-sending is allowed anytime.
5. **Note = summary + recording link** (no full transcript pasted inline).
6. **v1 button lives on the lead detail page only.**

## Non-goals (v1 / YAGNI)

- Automatic handoff on booking or on a "qualified" signal.
- Assigning the pushed lead to a specific Close user (the team triages via their
  Close smart views).
- Bulk handoff from the Hot Leads tab or the leads list.
- Two-way sync or pulling anything back from Close.
- A new lead status / pipeline stage. The "handed off" indicator is read from the
  audit log, not stored as a status.

## Reuse (existing)

- `src/lib/close/api.ts` — `findCloseLeadByEmail`, `createCloseLead`,
  `closeSenderEmail`, `sendCloseEmail`. Base `https://api.close.com/api/v1`.
  Per-user auth via `user_integrations.close_api_key` (the lead **owner's** key).
- The AI `send_email` tool already exercises the find/create-lead path, so the
  pattern (and its "not connected → mock" fallback) is proven.
- `system_events` audit table (`kind` / `actor_user_id` / `ref_table` / `ref_id`
  / `payload`) — already used for tool events and outcome overrides.
- Lead detail page data; `calendly_events` (booked appointment); the ElevenLabs
  recording-link format `…/app/agents/agents/{agentId}/history/{conversationId}`
  (agent id via `agents.elevenlabs_agent_id`, conversation id on the call).

## Components & changes

### 1. Close API — add a note capability

`src/lib/close/api.ts`: add
`createCloseNote(apiKey, { closeLeadId, note }): Promise<{ id: string } | null>`
→ `POST /activity/note/` with `{ lead_id, note }`. Returns null on failure so the
caller can surface a clean error.

### 2. Handoff note builder (new, pure/testable)

`src/lib/close/handoff.ts`: `buildHandoffNote(input): string`, built from:

- **lead** — company, `owner_name`/`manager_name`/`employee_name`,
  `business_phone`, `business_email`, `timezone`, `city`/`state`, custom values.
- **packaged call** — `summary`, `disposition`, `extracted_data` (incl.
  `lead_response_time`, `decision_maker_reached`), `started_at`,
  `elevenlabs_conversation_id`, and the agent's `elevenlabs_agent_id` (for the
  recording link). Choose the **most recent call that has a summary**; fall back
  to the most recent call.
- **appointment** — the lead's earliest upcoming `calendly_events` row
  (`scheduled_at`, `event_uri`); if none upcoming, the most recent.

Output (plain text; lines with no data are omitted):

```
Handed off from Smile & Dial — <date>

WHO TO MEET: <owner/manager name> (<role>)
COMPANY: <company> · <city, state>
PHONE: <business_phone>   EMAIL: <business_email>

BOOKED APPOINTMENT: <weekday, Mon D, h:mm A> (<lead timezone>)   [Calendly: <event link>]

AI CALL SUMMARY (<call date>):
<summary>

KEY ANSWERS:
• Lead response time: <lead_response_time>
• Decision-maker reached: <yes/no>
• <custom field>: <value>

RECORDING: <ElevenLabs conversation link>
```

Appointment time is formatted in the **lead's timezone** (consistent with the
booking fix in #238).

### 3. Server action

`src/lib/close/actions.ts`: `handoffLeadToClose(leadId): Promise<{ error: string | null; closeLeadId?: string }>`

1. Require a signed-in **admin** (in-code admin gate + service-role writes — same
   pattern as `deleteCalls` / `deleteCallbacks`).
2. Load the lead (owner, company, phones, emails, names, timezone, custom
   values), the packaged call (+ agent `elevenlabs_agent_id`), and the
   appointment.
3. Resolve `close_api_key` for the lead's owner. **None → return
   `{ error: "Connect Close in Settings → Integrations first." }`** (no writes).
4. Find the Close lead by `business_email` (`findCloseLeadByEmail`); if not found,
   `createCloseLead` (company, contact name, email, phone). If the lead has **no
   email**, `createCloseLead` by company + phone (skip the find step; weaker
   dedup, acceptable).
5. `buildHandoffNote(...)` → `createCloseNote(...)`. If the note post fails →
   return the error (do **not** log a half-completed handoff).
6. On success, insert `system_events` (`kind: "lead_handoff"`,
   `actor_user_id = user.id`, `ref_table: "leads"`, `ref_id: leadId`, `payload:
{ close_lead_id, note_id, packaged_call_id, at }`) and
   `revalidatePath("/leads/[id]", "page")`.

### 4. UI

- `src/app/(app)/leads/[id]/send-to-closer.tsx` (client) — `SendToCloserButton`:
  a button with a confirm dialog that calls the action in a `useTransition`,
  toasts success ("Sent to closer in Close.") or the returned error, and
  `router.refresh()` on success.
- Lead detail page — render the button **admin-only** in the top action area.
  The server page also fetches the **latest `lead_handoff`** system_event for the
  lead and, when present, threads a plain object (`{ at, byName }`) to show a
  muted badge **"Handed off to closer — \<date\> by \<name\>"** next to the
  button. (Server→client passes data only, never functions — RSC rule.)

## Data flow

Operator clicks → action gathers context → Close (find/create lead → post note)
→ `system_events` log → `revalidate` → badge appears. Re-click repeats (a fresh
note each time; the Close **lead** is deduped by email).

## Error / edge handling

- Owner hasn't connected Close → friendly error, no writes.
- Lead has no email → create by company/phone; the note still posts.
- Close API / network failure at any step → return the error, write nothing
  (retry stays clean).
- Non-admin → button not rendered; the action rejects.
- Lead with no call/summary/appointment → the note posts with whatever exists
  (the empty lines are omitted).
- **Recording link caveat:** the ElevenLabs link requires ElevenLabs workspace
  access. The note is still useful without it (summary + key answers are
  self-contained). If the sales team lacks EL access, a follow-up can swap in a
  login-free recording URL (the app already has a token-gated share-recording
  route) — out of scope for v1.

## Testing (Playwright, live-env only)

`tests/lead-handoff.spec.ts`:

1. **Note builder (deterministic):** call `buildHandoffNote` with a seeded lead +
   call + appointment and assert the output contains the appointment time in the
   lead's timezone, the summary, the key answers, and the recording link.
2. **Not-connected path:** as an admin owner with **no** `close_api_key`, invoke
   the action and assert the friendly error **and** that no `lead_handoff`
   system_event was written.
3. **Button visibility:** the button renders for an admin and not for a non-admin.

The live Close API is not called in CI (no key seeded), so no external
dependency. A manual smoke test with a real connected Close key covers the happy
path.

## Verification gates (run locally)

`npx tsc --noEmit`, `npx eslint`, `npm run build` — clean (only the 3 pre-existing
`twilio-*.spec.ts` baseline errors). **No DB migration.**
