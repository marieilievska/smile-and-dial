# Daily webinar booking — design

**Date:** 2026-09-01
**Status:** approved in conversation; implemented on `feat/daily-webinar-booking`

## Why

The HireAI webinar ("Answer Every Call, Book Every Lead") moves from one fixed
date (August 27) to a **recurring session every weekday at 2 PM Eastern, 30
minutes, on Zoom**. The Calendly event caps at 50 invitees (the operator tracks
fill manually and expects ~15 to show) and only lets invitees book **~4 days
ahead**, by choice: a seat booked weeks out is a seat nobody shows up for.

The live ElevenLabs prompt and the booking tools were built for the one-date
model, and from a business owner's seat the script had real show-rate leaks:

- The date and time were only spoken if the owner hedged. A clean "sure" went
  straight to email capture; the owner hung up not knowing when it was.
- The length of the event was never stated.
- The prompt contradicted itself: Section 5 forbade offering a recording, the
  "just email me" objection promised one; Section 6 referenced a "Section 6b
  text opt-in" that did not exist (and nothing in the code captures one).
- The CRM name was used once in the opener and never again.
- "August 27" was hardcoded in three places, and a four-zone timezone table
  (missing Alaska, Hawaii, Atlantic Canada) asked the model to do time math.
- The availability tool took no date and returned the first three openings of a
  six-week scan, so "does Thursday work?" could not be answered.

## Decisions (and why)

| Decision                                                                                      | Why                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Look ahead **5 days** in one Calendly query (`OFFER_LOOKAHEAD_DAYS`)                          | Covers the host's ~4-day booking range with a day to spare. Calendly stays the source of truth: if its range changes under 5 days nothing here changes.                                                                                                                           |
| Return **every** open session in that window (capped at 6), not the first 3                   | One tool call gives the agent the whole menu, so "Thursday?" is answered from the list with no second round-trip (dead air on the phone). Within 5 days a weekday name can never be ambiguous, so no "this Thursday or next?" logic is needed.                                    |
| Each slot carries `when` = today / tomorrow / weekday, computed on the **lead's** calendar    | Lets the agent lead with "tomorrow at 1" without date math. Computed in the lead's timezone because late in a Pacific evening the lead's tomorrow is already today in UTC.                                                                                                        |
| Labels stay in the lead's local time; the prompt's timezone table is deleted                  | Anything the model has to compute is something it can get wrong. Code hands it finished sentences.                                                                                                                                                                                |
| No seat counting                                                                              | Capacity is 50 and tracked by hand. A rejected booking still fails gracefully ("that time is no longer open, offer the next one").                                                                                                                                                |
| Agent leads with the **soonest** session, then names the other open days, then a **callback** | Approach A: show rates fall with lead time. A conflict is now "what day works" instead of goodbye, and "I don't know my week" becomes a scheduled callback (reusing the gatekeeper callback path) rather than a dead end.                                                         |
| **Never mention a recording**, never send "the info" instead of a seat                        | The invite email is what they get. "Just email me" is redirected to a day, then to a callback if they still won't pick.                                                                                                                                                           |
| Every yes hears day, time and length **before** email capture; the sign-off restates the day  | The single biggest show-rate leak in the old script.                                                                                                                                                                                                                              |
| Campaign flag `fixed_time_booking` must be **OFF** for this campaign                          | That flag books the soonest opening without a `slot_id`. It was right for one session; with daily sessions it would silently book tomorrow when the owner said Thursday. The long six-week scan behind it (`soonestCalendlyOpening`) is left intact for any future one-off event. |
| Repo webinar **template** drops `event_date` for `event_schedule` + `event_length`            | So the next agent built from the template doesn't inherit a date that goes stale.                                                                                                                                                                                                 |

## Code changes

- `src/lib/calendly/booking.ts`
  - `OFFER_LOOKAHEAD_DAYS = 5` (documented).
  - `availabilityWindows` gains `spanDays` (clamped under Calendly's 7-day cap); defaults unchanged.
  - `relativeDayLabel(slotISO, nowMs, timeZone)` — pure, unit-tested: "today" / "tomorrow" / weekday on the lead's calendar.
- `src/lib/elevenlabs/tool-webhook.ts`
  - `get_available_times`: one 5-day window, all sessions (cap 6), each `{ slot_id, label, when }`; result messages tell the model what the fields mean and, when empty, to offer a callback rather than invent a time. Mock slots carry `when` too.
  - `book_appointment` slot-gone failure message no longer sounds like a line to read; it tells the model to offer the next open option.
- `src/lib/elevenlabs/server-tools.ts` — `get_available_times` description updated (needs an agent **Resync** to reach ElevenLabs).
- `src/lib/agents/prompt.ts` — the template builder's tool blocks describe the list, `when`, and the graceful failure.
- `src/lib/agents/templates/webinar.ts` — schedule/length key-details, daily-model script prose, goal = seat booked.
- Tests updated/added: `calendly-booking`, `agent-templates`, `agent-validate`, `agent-preview`, `agent-assemble`, e2e `agents.spec`.

## The live ElevenLabs prompt

The webinar agent's prompt is managed in the ElevenLabs dashboard, not in our
database. The full rewritten prompt is in
`docs/agent-prompts/hireai-webinar-invite-daily.md`; the operator pastes it in.

## Operator checklist (outside the code)

1. **Calendly**: the event type is a group event, every weekday, 2:00–2:30 PM
   Eastern, max 50 invitees, invitees can book up to 4 days out, minimum notice
   as desired (this alone decides whether "today at 2" is ever offered).
2. **Calendly Workflows**: add a reminder ~1 hour before. Most seats will be for
   _tomorrow_, so the default "1 day before" reminder often fires never. The
   sign-off deliberately promises only the invite, not a reminder.
3. **Campaign settings**: the campaign's Calendly event is the daily webinar;
   **fixed-time booking is OFF**.
4. **ElevenLabs**: paste the new prompt into the agent; after deploy, hit
   **Resync** on the agent so the updated tool description is pushed.
5. **Test one call** and check that the offered times read as the lead's local
   time and that "Thursday" books the Thursday in the list.

## Out of scope (deliberately)

- Seat-remaining counts and a "session full" fallback beyond the graceful
  failure (capacity is 50, tracked by hand).
- Text-message reminders / opt-in (nothing captures it; would be its own project).
- A per-day roster view in Reporting.
