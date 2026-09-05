# Cohort reporting — design

**Date:** 2026-09-05
**Status:** approved in conversation; not yet implemented

## Why

Daily spend buys registrations on the **dial day**. Those people attend a
webinar 0–7 days later and buy after that. The operator's spreadsheet divides
one day's cost by the same day's attendance, which compares strangers:

| Date | Calls | Connected | DMs | Regs | Attended | Sales | Cost    | $/reg  | $/attended |
| ---- | ----- | --------- | --- | ---- | -------- | ----- | ------- | ------ | ---------- |
| 9/2  | 2485  | 840       | 70  | 5    | 0        | 0     | $231.42 | $46.28 | /          |
| 9/3  | 3070  | 1269      | 96  | 10   | 4        | 0     | $298.56 | $29.86 | $132.50    |
| 9/4  | 2109  | 1190      | 37  | 5    | 0        | 0     | $214.80 | $42.96 | /          |

Verified against the live database on 2026-09-05:

- **All five** of 9/2's registrations booked the **9/3** session. That is why
  9/2 shows zero attendance — not a bad day, an unfinished one.
- Of the four people who attended on 9/3, **two came from 9/2's spend and two
  from 9/3's**. The $132.50 figure divides the pooled 9/2+9/3 spend ($529.98)
  by all four — an ad-hoc cohort calculation, and proof that a per-day row
  cannot answer the question.
- 9/4's five registrations were all for sessions on 9/8–9/10, so its cost per
  attended is not merely zero, it is **unknowable** at the time of reading.
- One registration (Benjamin Salon New York, registered 9/2 for the 9/3
  session) was **never marked** either way and still sits at `goal_met`.

True ripe numbers: 9/2 earned 2 attendees at **$115.71 each**. 9/3 and 9/4 are
not yet judgeable — 12 of their 15 registrations had not had their session.

## Decisions (and why)

| Decision                                                                                           | Why                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A cohort is the **dial day**; every downstream outcome flows back to it, however late              | The money was spent that day. This is vintage reporting, as used for ad spend and loan books.                                                                                                                                                                                    |
| `dial_day` is a **stored column**, not derived from `created_at`                                   | A rescheduled booking is created on the day of the reschedule. Deriving the cohort from `created_at` silently moves a person from the day that paid for them to a day that did not, inflating one day and deflating another.                                                     |
| Registrations **exclude cancellations**                                                            | Matches the operator's own count: 9/3 had 11 bookings, one cancelled, she counted 10.                                                                                                                                                                                            |
| A day is **Final** once every registration's session is 7+ days past; otherwise `N pending`        | Sales window chosen by the operator. Prevents reading an unfinished day as a bad one.                                                                                                                                                                                            |
| Unripe ratios render in **muted italics**, not hidden                                              | Keeps a feel for the day while making it obvious the number will move.                                                                                                                                                                                                           |
| **Attendance is the only thing clicked.** No-show is derived                                       | The operator marks attendees after each session; everyone else in that session did not attend. Halves the clicking.                                                                                                                                                              |
| Sessions **auto-reconcile 24h after they end**; one reconciling with zero attendance marks warns   | Without a reconciliation signal, a session the operator forgot reads as a genuine 0% show rate, indistinguishable from everyone standing her up. This makes forgetting loud rather than silent — the Benjamin Salon failure.                                                     |
| **Rescheduled** is a new pipeline status; dragging there asks which upcoming session they moved to | The operator marks reschedules by hand from Calendly's emails. The person returns to Upcoming on the new date with `dial_day` preserved, so they stay tracked and the credit stays on the day that paid.                                                                         |
| Sales are a **count only**, no amount                                                              | Operator's call. Yields cost per sale and close rate; no ROI or payback.                                                                                                                                                                                                         |
| Metric definitions are the **app-wide ones**                                                       | `call` = any `calls` row in the ET day, all directions; `connected` = `CONNECTED_OUTCOMES`; `DM` = the lead's sticky `decision_maker_reached`. The tab then cannot drift from Reporting, Costs or Numbers. Note this reads 2,604 calls for 9/2 where the spreadsheet said 2,485. |
| Outcomes stored as **columns on `calendly_events`**, not a new table                               | That table is already one row per person per session, already survives a wipe (`lead_id` is `on delete set null`), and already holds the registration date, session date, email and name. A parallel table would need syncing forever.                                           |
| Aggregation runs as **one SQL function**, not JavaScript                                           | PostgREST caps every response at 1,000 rows and there are 8,123 calls across three days. JS-side aggregation would silently undercount — the bug behind #218.                                                                                                                    |
| That function is **`SECURITY INVOKER`**                                                            | `SECURITY DEFINER` bypasses RLS. Copying the `refresh_cost_rollup()` pattern here would show every member every other member's leads, costs and registrations through a report that looks correctly scoped.                                                                      |
| `/reporting` **drops its admin gate**; members see their own leads via RLS                         | Requested. `calls_select` already reads "admin sees all, else leads you own", as do `leads`, `calendly_events` and `cost_rollup_daily`. No new permission code — the database already enforces it.                                                                               |
| **Voice of Customer and Hot Leads tabs are deleted** for everyone                                  | Requested. Tabs and view components go; the underlying tables and the `ai_answering_stance` extraction stay, since Cause of Death still uses that data and dropping them is destructive and separate.                                                                            |
| **App Changelog and Agent Prompt Log stay admin-only and are hidden from members**                 | Their RLS is `is_admin`-only, so they would render blank for a member. Hidden via the existing `reportingTabsFor` filter rather than opened up.                                                                                                                                  |
| Cohorts is **not** on the public `/share/reporting` surface                                        | It exposes cost per registration and per sale. Revisit if external sharing is wanted.                                                                                                                                                                                            |
| Pre-wipe history is **discarded**                                                                  | Operator chose a clean slate for the Monday restart, accepting the loss of the 12 in-flight registrations.                                                                                                                                                                       |

## Data model

Three columns on `public.calendly_events`:

- `dial_day date` — the ET day of the call that produced the booking. Stamped
  at insert; **preserved** when a registration is rescheduled.
- `attended_at timestamptz null` — set from the Goals pipeline.
- `sale_at timestamptz null` — set from the Goals pipeline.
- `rescheduled_at timestamptz null` — when the registration was last moved to a
  different session. Only there so the cohort table can show churn; it does not
  affect any other calculation.

One constraint change: `leads_status_check` gains `rescheduled`. The constraint
lists every allowed status, so the value must be added there or the write is
rejected.

All changes are additive — nothing is dropped or renamed, so deploy order
cannot break a running app.

### Registration states

| State     | How it is set                                               |
| --------- | ----------------------------------------------------------- |
| Upcoming  | `scheduled_at` is in the future                             |
| Attended  | `attended_at` set from the pipeline                         |
| No-show   | Session passed, session reconciled, `attended_at` null      |
| Cancelled | `status = 'canceled'`; not counted as a registration at all |

Rescheduling is an **event, not a state**. Moving someone updates
`scheduled_at`, stamps `rescheduled_at`, and returns them to **Upcoming** on the
new date — where they can still be attended or no-show as normal. The cohort
table's `Rescheduled` column counts registrations with `rescheduled_at` set, as
a churn signal only; those people are still counted in their cohort's
registrations and in the show rate once their new session passes.

## The report

A new **Cohorts** tab in Reporting containing two things.

**The cohort table** — one row per dial day, filling in over the following
week:

`Dial day | Calls | Connected | DMs | Regs | Attended | No-show | Rescheduled | Sales | Spend | $/reg | $/attended | $/sale | Status`

`Status` reads `Final` once every registration's session is 7+ days past,
otherwise `N pending`.

**A rolling-rates panel** — 30-day show rate and close rate, today's cost per
registration, and projected cost per sale.

## Read path

One `SECURITY INVOKER` SQL function returning finished per-dial-day rows: calls,
connected, DMs, registrations, attended, no-show, rescheduled, sales, spend, and
the ripeness flag. Spend joins `cost_rollup_daily`; call metrics come from
`calls` joined to `leads` for the sticky DM flag; registration outcomes group
`calendly_events` by `dial_day`.

The rolling-rates panel derives from the same function over 30 days: show rate
(attended ÷ attended + no-show, past sessions only), close rate (sales ÷
attended), and projected cost per sale (`$/reg ÷ show ÷ close`).

Each rate is suppressed below a minimum sample rather than printing a confident
number off three people, in the spirit of the best-time heatmap's 8-sample
threshold: the **show rate needs 10 reconciled registrations**, the **close rate
needs 5 attendees**, and the projection needs both. Below that each reads "not
enough data yet". These thresholds live in one named constant so they can be
tuned without hunting through the query.

The warning for a session that auto-reconciled with zero attendance marks
surfaces in **both** the Cohorts tab and the Goals page, since the fix (marking
the attendees) happens on Goals.

## Write path

1. `tool-webhook.ts:1339` — stamp `dial_day` on the booking insert.
2. `transitionLeadGoalStatus` — when a lead becomes `attended` or `sale`, also
   stamp the matching registration: the most recent session that has already
   started and is still unmarked. That matches "I am marking the webinar that
   just happened" and handles a rebooking sensibly.
3. A new server action for the reschedule picker: update `scheduled_at`, keep
   `dial_day`, log a `registration_rescheduled` system event.

## Access model

- `/reporting` loses its `role !== "admin"` redirect.
- Members see **Dashboard, Cause of Death, Cohorts, Numbers**, each scoped by
  RLS to leads they own.
- **App Changelog** and **Agent Prompt Log** are filtered out for members by
  `reportingTabsFor`, the same mechanism that already hides Numbers from the
  public share.
- The page must not run admin-only queries for a member request; tab data
  loading is gated on the resolved tab list, not on the raw query parameter.
- A member requesting an admin-only tab by URL is redirected to Dashboard.

## Wipe changes

`scripts/wipe-data.mjs` does not clear `calendly_events` or
`cost_rollup_daily`. Left alone, the first Cohorts view after the Monday wipe
shows three zombie rows — 9/2–9/4 carrying spend and registrations with no calls
and no outcomes. Both tables must be cleared.

`scripts/backup-before-wipe.mjs` backs up neither table, so registrations would
be deleted with no copy anywhere. Both must be added.

Separately, a standalone CSV of the 12 in-flight registrations (8 for the Monday
2 PM session, 2 each for 9/9 and 9/10) is dumped before the wipe, so a sale from
one of them can be reconciled by hand.

## Delivery

Four phases, one PR each, in this order. The first is time-critical — it has to
land before the Monday wipe or the clean slate is not clean.

1. **Wipe safety** — clear `calendly_events` and `cost_rollup_daily` in
   `wipe-data.mjs`, add both to `backup-before-wipe.mjs`, dump the in-flight
   CSV. Ships before Monday, independent of everything else.
2. **Data model** — the three `calendly_events` columns, the
   `leads_status_check` change, and the `dial_day` stamp on the booking insert.
   Additive and inert until something reads it.
3. **Marking** — the `Rescheduled` pipeline column with its session picker, and
   `transitionLeadGoalStatus` writing through to the registration.
4. **The report** — the SQL function, the Cohorts tab, the rolling-rates panel,
   the access-model change, and the removal of Voice of Customer and Hot Leads.

Phase 4 is the only one a member's access changes in, so it is also the only one
needing an RLS check as a non-admin before merge.

## Testing

Pure unit tests for the cohort maths — ripeness, show rate, close rate,
projection, and the divide-by-zero cases that yield `Infinity` on a day with no
attendees — following the pure-module pattern of `classify-outcome.ts` and
`calendly/booking.ts`. Verified with `tsc`, `next build` and `eslint`;
Playwright CI was removed in June, so there is no automated gate.

RLS must be verified by querying the function as a member, not merely by reading
the policy — the whole access model rests on `SECURITY INVOKER`.

## Out of scope

- The Calendly webhook subscription. The handler already parses reschedules
  (`invitee.canceled` with `rescheduled: true`, then `invitee.created` with
  `old_invitee`) but **zero** `calendly_*` events have ever reached the app, so
  nothing is subscribed. Reschedules are marked by hand instead.
- Sale amounts, ROI, payback.
- Importing a webinar attendee list.
- A per-session checklist view, and CSV export of the cohort table.
- Dropping the Voice of Customer / Hot Leads tables or their extraction.

## Known limits

- Reschedules are caught only when the operator notices them. A quiet reschedule
  still reads as a no-show; the webhook is the only fix.
- No revenue, so a cost per sale cannot be judged good or bad from this report
  alone.
- The Numbers tab shows members the whole shared pool, not their own numbers —
  `twilio_numbers` was deliberately opened to all members in August.
- Members see the Dashboard without the per-day operator notes
  (`dashboard_notes` remains admin-only).
- A registration created by the Calendly webhook, if it is ever subscribed,
  would have no `dial_day` and must fall back to its `created_at` ET day.
