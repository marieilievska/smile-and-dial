# Double calling — design

**Date:** 2026-07-27
**Status:** approved, not yet implemented

## What we're building

When an outbound call hits voicemail, dial the same lead again straight away
from the same number. The lead sees two missed calls under a minute apart, which
reads as "someone actually needs me" rather than one more ignorable robocall.

Opt-in per campaign. Off everywhere by default, including existing campaigns.

## What exists today

- Voicemail is already a retry outcome. `applyRetryForCall` puts the lead on the
  unified 2d → 2d → 15d cycle (`RETRY_DELAY_DAYS`, positions 0 → 1 → 2 → 0),
  setting `next_call_at` to 9am lead-local N days out, or the heatmap's best hour
  when the campaign has smart scheduling on.
- The cycle **never ends**. `retry_counter` only increments; nothing marks a lead
  exhausted. A lead that never answers is called forever. See "Out of scope".
- `dial_queue` (a view) selects leads with `status in ('ready_to_call','callback')`
  and `next_call_at is null or next_call_at <= now()`, ordered by `next_call_at`
  ascending with `dial_priority` putting callbacks first.
- The dialer tick runs on pg_cron every minute (`* * * * *`).
- `pre_call_check` blocks a lead with a call in `queued/dialing/ringing/in_progress`
  within 15 minutes. It does **not** block on completed calls, so a redial needs
  no guard relaxed.
- A partial unique index (`calls_one_active_ai_outbound_dial_per_lead`) allows one
  ACTIVE ai outbound dial per lead. Call 1 is completed before the redial is
  scheduled, so this is not a blocker either.

## Decisions

Each of these was chosen over a stated alternative.

**Trigger: `voicemail` only.** Not `no_answer`, which is arguably the same
situation from the lead's side, and not `busy`, where most carriers surface a
manual "decline" identically to a genuinely engaged line — redialling someone who
just pressed reject is the worst case. Narrower and more predictable was
preferred.

**Timing: no delay constant.** The engine sets `redial_at = now()` and the next
tick places the call. Measured on 14 real calls, the outcome reaches us
**0.1–0.3s after the call ends** (median 0.2s), so the gap is driven entirely by
the tick: **0–60s, typically ~30s**. An earlier draft used a fixed 90-second
delay; it was dropped because a magic number bought nothing over "as soon as the
system can".

**Same number.** The pool picks least-used-first, so left alone the redial would
usually come from a _different_ number — two unrelated numbers in the lead's call
log, which reads more like a spam operation than one person trying twice. The
redial explicitly reuses call 1's number.

**Which cycle steps double: positions 0 and 2 only.** Not every attempt. The
opener and the step before the 15-day gap get doubled; the middle one doesn't.

**The pair counts as ONE attempt.** The cycle advances once, on call 1. Call 2 is
marked `is_redial` and skips the advance, so a lead's lifespan is unchanged —
same number of cycle steps, just more dials at two of them.

**Advance the cycle immediately, redial on a separate clock.** The rejected
alternative was to reuse `next_call_at` for the redial and defer the cycle
advance until call 2 landed. That fails badly: if the redial never fires (outside
calling hours, campaign paused, caps hit, pool empty) the lead is left past-due,
still flagged for redial, a cycle step behind, and gets dialled next morning from
a stale number. Silent and permanent. Advancing immediately means an unfired
redial costs nothing — the lead is already scheduled correctly.

## Data model

```
campaigns.double_call_enabled   boolean not null default false
leads.redial_at                 timestamptz            -- pending redial, null when none
leads.redial_number_id          uuid → twilio_numbers  -- the number to reuse
calls.is_redial                 boolean not null default false
```

No backfill. Every existing campaign stays off; every existing lead has a null
`redial_at`.

## Flow

1. Call 1 ends with outcome `voicemail`. `applyRetryForCall` runs and advances the
   unified cycle exactly as it does today.
2. In the same lead update, having captured `retry_position` before the advance
   overwrote it, it evaluates the redial condition — all four must hold:
   - the campaign has `double_call_enabled`
   - `calls.is_redial` is false for this call (a redial can't spawn a redial)
   - the lead's retry position **before** the advance was 0 or 2
   - the outcome is `voicemail`
3. If they hold, it writes `redial_at = now()` and `redial_number_id` = call 1's
   `twilio_number_id` onto the lead.
4. The next tick (≤60s) sees the lead through the queue's new redial branch.
5. Placement uses `redial_number_id` when that number is still usable, sets
   `calls.is_redial = true`, and clears `redial_at` / `redial_number_id`.
6. Call 2 ends. The engine sees `is_redial` and skips **both** the cycle advance
   and the redial check.

An **unconsumed marker is left in place, not cleaned up**. Once `redial_at` is
older than the 10-minute window it is inert — the queue ignores it — and the next
qualifying voicemail overwrites it. There is no sweeper and none is needed.

## Queue integration

`dial_queue` gains a second eligibility branch:

```sql
and (
      (l.next_call_at is null or l.next_call_at <= now())
   or (l.redial_at is not null and l.redial_at > now() - interval '10 minutes')
)
```

ordered by `dial_priority, coalesce(l.redial_at, l.next_call_at)`.

**This ordering is load-bearing.** Because the cycle advances on call 1, the
redial lead's `next_call_at` is two days in the _future_. Under the existing
`order by next_call_at asc` it would sort behind every one of the ~33k due leads
and never fire inside its window. Sorting on `redial_at` when present puts it at
the front of its priority tier. Callbacks keep priority 0 — they are promises to
real people and stay ahead of redials.

The 10-minute box is the safety property: a marker that can't be consumed simply
expires.

## Failure modes

| Situation                                             | Behaviour                                                                                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Redial falls outside calling hours                    | `pre_call_check` blocks it; window expires; lead already scheduled 2 days out                                                              |
| Campaign paused / autopilot off between the two calls | Lead drops out of the queue; window expires; no stuck state                                                                                |
| Hourly, daily, concurrency or spend cap hit           | Same — window expires, nothing to unwind                                                                                                   |
| `redial_number_id` retired, rested or flagged         | Fall back to normal pool selection. A second call from another number is worth less than one from the same number, but more than no call   |
| Pool empty                                            | Window expires                                                                                                                             |
| Lead has a pending callback                           | Untouched. Voicemail on a callback lead escalates the callback (+30min → next day → missed) and returns before the redial check is reached |
| Call 2 reaches a human                                | Normal outcome handling. Whatever call 2 dispositions to governs the lead                                                                  |
| Call 2 hits voicemail again                           | Cycle already advanced on call 1; lead waits for its next scheduled step                                                                   |

## Cost

Per 3-step cycle a never-answering lead goes from **3 dials to 5** (2 + 1 + 2) —
up to **+67%**, against +100% if every step doubled. The real increase is lower,
since only voicemail triggers it and `no_answer` / `busy` do not.

## Carrier reputation

Two calls to the same number under a minute apart, repeated across a list, is a
pattern carrier analytics score on. This directly opposes the connect-rate work
done on 2026-07-27 (per-number caps removed, connect-rate history added as the
replacement guardrail).

Recommendation: enable on one campaign and watch the per-number connect-rate
sparkline on Settings → Twilio numbers for a week before making it the default.
The auto-rest monitor (rests a number below 10% connect over ≥20 calls, flags
below 5%) is the backstop, but it acts after the damage rather than before.

## Testing

**Unit** (pure trigger logic, extracted so it can be tested without I/O):

- fires only when the campaign has opted in
- fires only on `voicemail` — not `no_answer`, `busy`, `gatekeeper`, or a human outcome
- fires at retry positions 0 and 2, never at 1
- never fires for a call already marked `is_redial`
- the pair advances the cycle exactly once

**Playwright** (against the live DB, mirroring `tests/dialer-tick.spec.ts`):

- a voicemail on an opted-in campaign writes `redial_at` and `redial_number_id`
- a voicemail on an opted-out campaign writes neither
- the queue surfaces a lead whose `redial_at` is inside the window and whose
  `next_call_at` is two days out
- a `redial_at` older than 10 minutes is not surfaced
- a redial call is placed on the stored number and marked `is_redial`

## Out of scope

**Leads are called forever.** `retry_counter` only increments and no state marks
a lead exhausted, so a number that never answers cycles 2d/2d/15d indefinitely.
This surfaced while defining "last try" and is a real problem independent of this
feature — doubling the dials at two of every three steps makes it more expensive,
not newly broken. Worth its own piece of work: a max-attempts setting, an
exhausted lead state, and a decision about leads already past that limit.
