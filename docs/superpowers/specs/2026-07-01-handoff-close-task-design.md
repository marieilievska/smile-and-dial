# Assign a Close task to the appointment's closer on handoff — Design

**Date:** 2026-07-01
**Status:** Design approved, pending spec review

## Problem

The shipped "Send to closer" handoff (#239) posts a context **Note** to Close, but a note doesn't land in anyone's **Inbox**. Referrizer wants each handoff to also create a Close **Task assigned to the closer who hosted the booked appointment**, so it shows up as an actionable item in that person's Close Inbox.

## Decisions (approved)

1. **Extend the existing `handoffLeadToClose` action** (same "Send to closer" button). The Task is created IN ADDITION to the note, on every handoff.
2. **Assignee = the appointment's host.** Fetch the booked appointment's Calendly event host email (from `calendly_events.event_uri`, via the lead owner's Calendly token), match it to a Close user, and assign the task to them. Reading the event's actual host works whether closers have their own calendars or share a round-robin one.
3. **Fallback assignee = the Close account owner** (the connected key's own user, via Close `/me/`) when there's no resolvable appointment/host, or no Close user matches the host email. If even `/me/` can't be resolved, the task is created **unassigned** (still on the lead — never lost).
4. **Due = today** (right away), so it's immediately actionable in the Inbox.
5. **Task text** names the company, the appointment time (in the lead's timezone), and the contact, and points to the handoff note.
6. **Best-effort:** if the task fails to create after the note already posted, the handoff still returns success and server-logs the failure — same rule as the audit log, to avoid a re-send that would duplicate the note.
7. A task is created on **every** handoff. Re-sending duplicates the task (documented caveat).

## Non-goals (YAGNI)

- Auto-creating the task on booking (it rides the manual handoff).
- Deduping or updating an existing task on re-send.
- Configurable per-campaign closer mapping (assignee is resolved from the appointment host's email).
- Due-at-appointment-time or day-of scheduling (chose "right away").

## Reuse / current state

- `handoffLeadToClose` (`src/lib/close/actions.ts`) already: admin-gates, resolves the owner's `close_api_key`, finds/creates the Close lead (`ref.leadId`), fetches the appointment (`appt` with `event_uri`, `scheduled_at`), posts the note, logs a `lead_handoff` `system_events` row. We extend it between "note posted" and "audit log".
- `calendly_events` has `event_uri` (`https://api.calendly.com/scheduled_events/{uuid}`), `scheduled_at`, `owner_id`, `lead_id`.
- Calendly token lives in `user_integrations.calendly_api_key` for the lead owner (same source `resolveCampaignCalendly` in `tool-webhook.ts` uses).
- Close client (`src/lib/close/api.ts`): HTTP Basic with the key; `createCloseNote`/`createCloseLead`/`findCloseLeadByEmail` already exist. Base `https://api.close.com/api/v1`.
- `buildHandoffNote` (`src/lib/close/handoff.ts`) already has a private `fmtInZone(iso, tz)` that formats a time in the lead's timezone (with a malformed-tz fallback). The task-text builder lives in the same file and reuses it.

## Components & changes

### 1. Calendly API — resolve the event host

`src/lib/calendly/api.ts`: `getScheduledEventHostEmail(eventUri, token): Promise<string | null>` → GET `{eventUri}` → `resource.event_memberships[0].user_email`. Best-effort (returns null on any failure / missing field). If `user_email` is absent on some API version, fall back to resolving `event_memberships[0].user` (a user URI) via a GET → `resource.email`. Exact shape validated against a live event in the smoke test.

### 2. Close API — user lookup, current user, task

`src/lib/close/api.ts`:

- `findCloseUserByEmail(apiKey, email): Promise<{ id: string } | null>` → GET `/user/`, match `data[].email` case-insensitively → `{ id }` (a `user_…` id).
- `getCloseMe(apiKey): Promise<{ id: string } | null>` → GET `/me/` → `{ id }` (the key's own user; the fallback assignee).
- `createCloseTask(apiKey, { closeLeadId, text, assignedTo, dueDate }): Promise<{ id: string } | null>` → POST `/task/` with `{ lead_id, text, assigned_to?, date, is_complete: false }` (`assigned_to` omitted → unassigned). Null on failure. Exact field names (`assigned_to`, `date`) validated in the smoke test.

### 3. Pure task-text builder

`src/lib/close/handoff.ts`: `buildHandoffTaskText(input): string` (pure, reuses `fmtInZone`). Produces e.g.:

> `Run the booked demo with {Company} — {Weekday, Mon D, h:mm A} ({lead tz}). Contact: {who to meet} · {phone} · {email}. Full context is in the handoff note.`

Appointment time omitted gracefully if there's no appointment; contact bits omitted when absent.

### 4. Wire into `handoffLeadToClose` (after the note posts, before the audit log)

1. Load the owner's `calendly_api_key` (extend the existing `user_integrations` read to select both `close_api_key, calendly_api_key`).
2. Host email: if `appt?.event_uri` and a Calendly token exist → `getScheduledEventHostEmail(appt.event_uri, calendlyToken)`, else null.
3. Assignee id: `hostEmail ? findCloseUserByEmail(closeKey, hostEmail) : null`; if null → `getCloseMe(closeKey)`. (Either may be null → unassigned.)
4. `createCloseTask(closeKey, { closeLeadId: ref.leadId, text: buildHandoffTaskText(...), assignedTo: assignee?.id, dueDate: <today, YYYY-MM-DD> })`. On null → `console.error`, continue.
5. Add `task_id` + `task_assigned_to` to the `lead_handoff` audit payload.

"Today" = `new Date().toISOString().slice(0, 10)` (UTC calendar date — fine for a "right away" due date).

## Data flow

Handoff → note posted → resolve Calendly host email → match Close user (else `/me/`, else unassigned) → create the assigned Close task (due today) → audit log records the task id → return success.

## Error / edge handling

- No appointment / no `event_uri` / owner has no Calendly token → skip host lookup → assignee = account owner (`/me/`).
- Calendly host fetch fails, or host email matches no Close user → assignee = account owner.
- `/me/` also unresolvable → task created **unassigned** (still on the lead).
- Task creation fails → `console.error`, handoff still returns success (the note already posted).
- Admin gate / not-connected / note-failure paths unchanged from #239.

## Testing (Playwright live-env + unit)

- **Unit (pure):** `buildHandoffTaskText` — asserts the text contains the company, the appointment time in the lead's timezone, and the contact; and that it degrades gracefully with no appointment. Added to `tests/lead-handoff.spec.ts`.
- The Close/Calendly network calls are external → not run in CI. The existing not-connected contract still holds (no Close key → no task, no writes). A manual smoke test with a real connected Close + Calendly validates the exact API field names, host resolution, assignee matching, and that the task appears in the host's Inbox.

## Verification gates (run locally)

`npx tsc --noEmit`, `npx eslint`, `npm run build` — clean (only the 3 pre-existing `twilio-*.spec.ts` baseline errors). **No DB migration.**
