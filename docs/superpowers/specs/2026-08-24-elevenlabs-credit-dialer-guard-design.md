# ElevenLabs Credit Guard for the Dialer — Design

**Date:** 2026-08-24
**Status:** Design — awaiting review
**Author:** Claude + Marija

## Problem

Our ElevenLabs (EL) plan is a **single shared credit pool** for the whole workspace
(~2.11M credits/month, next reset 2026-09-03). There is **no per-user credit budget** —
every user's campaigns, plus inbound, draw from the same pool.

When the pool runs dry, EL kills calls with a quota termination reason. Today nothing in the
app watches the balance, so the dialer keeps placing calls against a dead account. On
2026-08-11 this caused an outage: **880 calls failed over ~5 hours with no signal** — ~816
instant 0-second rejects and ~64 **live humans cut off mid-conversation**. All landed in the
`ai_error` bucket.

We want the dialer to **stop placing calls before the pool runs out**, **tell the affected
people**, and **resume on its own** when credits are restored — so we stop wasting calls.

## Goal

1. Stop dialing before credits run out (prevent the wasted calls).
2. Pause each affected campaign and notify its owner so it's not a silent mystery.
3. Alert admins early enough to top up.
4. Resume automatically when credits return — no manual un-pausing.
5. Never take the whole dialer down over a transient EL API blip (fail-open on read errors).

## Decisions (locked with Marija)

| Decision                | Choice                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| Behavior when low       | **Stop dialing + alert + auto-resume**                                                        |
| Safety cushion          | **Balanced**                                                                                  |
| Who is affected         | **All active campaigns** (shared pool → everyone at once)                                     |
| On stop                 | Pause each active campaign + notify **its owner** (admin or teammate) + notify **all admins** |
| On warn (still dialing) | Notify **admins only** (only admins can top up EL)                                            |
| On resume               | Auto-resume **only campaigns we paused** + notify each owner + admins                         |

### Thresholds (all env-overridable — retunable without a code change)

Reference: avg call ≈ 530 credits; long booked call up to ~2,700; up to ~25 concurrent.

| Constant                     | Default               | Meaning                                                   |
| ---------------------------- | --------------------- | --------------------------------------------------------- |
| `EL_CREDIT_WARN_THRESHOLD`   | `100000` (≈190 calls) | Below this: warn admins, keep dialing                     |
| `EL_CREDIT_STOP_THRESHOLD`   | `35000` (≈65 calls)   | Below this: pause campaigns, stop dialing                 |
| `EL_CREDIT_RESUME_THRESHOLD` | `50000` (≈95 calls)   | At/above this again: auto-resume (hysteresis vs. stop)    |
| `EL_CREDIT_STALE_MINUTES`    | `15`                  | How long a cached balance is trusted if a live read fails |

`RESUME (50k) > STOP (35k)` deliberately — the gap stops the dialer flapping on/off right at
the line.

## State machine

State is derived from `remaining` credits, with hysteresis on the low↔resume boundary:

```
                 remaining >= WARN(100k)            -> ok
   STOP(35k) <= remaining <  WARN(100k)            -> warn
                 remaining <  STOP(35k)            -> low   (pause dialing)

   Once "low", stay "low" until remaining >= RESUME(50k), then recompute (ok/warn).
```

Transitions and their side effects:

| Transition               | Side effect                                                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `ok → warn`              | Notify admins: "credits low (~N calls left), top up soon." Keep dialing.                                                            |
| `* → low` (from ok/warn) | Pause all active campaigns (`paused_reason='low_credits'`); notify each owner + admins ("dialer paused"). Stop dialing.             |
| `low → low` (still low)  | Pause any campaign that became active since last tick (idempotent); notify only the newly-paused owners.                            |
| `low → warn/ok` (resume) | Auto-resume the campaigns we paused; notify each owner + admins ("credits restored, resumed"). Does **not** re-fire the warn alert. |

The **warn alert fires only on the downward `ok → warn` crossing**, never on the resume path
(prevState distinguishes them). Balance moves down during a dialing day and only jumps up on
reset/top-up, so warn flapping is not a practical concern in v1.

## Architecture

The check lives **inside the dialer tick** (`runDialerTick`, `src/lib/dialer/tick.ts`), run
once per tick (~1/min during calling hours) — **not** on a multi-minute cache. Timing matters:
after the balance crosses the stop line, the dialer keeps launching calls until its _next_
check, so a coarse cache would burn tens of thousands of credits blind between checks and
reintroduce the mid-call cutoffs the balanced cushion is meant to prevent. An EL balance read
is ~0.1–0.3s and 1/min is trivial for EL rate limits.

Because paused campaigns are already excluded from the dial queue **and** blocked by the shared
`pre_call_check` (`campaign_not_active`), pausing campaigns also stops manual **"Call Now"**
dials during an outage — for every user, for free.

### Components

1. **`getElevenLabsCreditBalance()`** — new, `src/lib/elevenlabs/subscription.ts`
   (first app-code reader of the EL subscription).
   - `GET https://api.elevenlabs.io/v1/user/subscription`, header `xi-api-key`,
     key via `process.env.ELEVENLABS_API_KEY?.trim()` (pattern: `place-call.ts:33`).
   - Returns `{ remaining, limit, used, tier, status, resetUnix } | null`.
     `remaining = character_limit - character_count` (EL kept the old field names).
   - Returns `null` on any network/HTTP error or timeout (does not throw).

2. **`evaluateCreditState(remaining, prevState, thresholds)`** — new **pure function**
   (`src/lib/elevenlabs/credit-state.ts`).
   - Returns `{ state, shouldDial, transition, notify: { warnAdmins?, paused?, resumed? } }`.
   - No I/O, no EL, no DB — the testability seam (see Testing). All the state-machine and
     hysteresis logic lives here.

3. **`elevenlabs_credit_status`** — new **single-row table** (migration).
   Columns: `id` (singleton PK), `remaining bigint`, `credit_limit bigint`,
   `state text check (state in ('ok','warn','low'))`, `checked_at timestamptz`,
   `updated_at timestamptz`.
   - Purpose: (a) `prevState` for transition detection across serverless invocations;
     (b) fail-open fallback (last-known balance + freshness).
   - A **dedicated table**, not `app_settings` — that row holds many secrets and is a known
     footgun for accidental full-row dumps.

4. **`enforceElevenLabsCreditGate(supabase)`** — new orchestrator
   (`src/lib/dialer/credit-gate.ts`), called from `runDialerTick` right after
   `makeServiceClient()` (~`tick.ts:472`), **before** `readFairQueue` (~496), and **only when
   `ELEVENLABS_LIVE === "live"`** (mock calls consume no credits).
   Flow:
   1. `live = await getElevenLabsCreditBalance()`.
   2. Load the `elevenlabs_credit_status` row (`prevState`, last balance, `checked_at`).
   3. **Fail-open handling:** if `live === null` → keep the prior state unchanged (no new
      pauses/resumes/notifications), log a throttled `system_events` row
      (`kind: 'elevenlabs_credit_check_failed'`), and return "proceed" if prior state wasn't
      `low` (or "blocked" if it was). Never pause on a read failure.
   4. `result = evaluateCreditState(live.remaining, prevState, thresholds)`.
   5. Persist `remaining`, `state`, `checked_at`.
   6. Apply side effects per the transition table (pause/resume/notify — see below).
   7. Return `{ dialingBlocked: !result.shouldDial }`. When blocked, the tick early-returns an
      annotated `TickSummary` (new `blockedReasons.low_credits`) and skips the queue work.

5. **Pause (service-role, in the tick).** `pauseCampaign()` requires a signed-in user, so the
   tick replicates its DB write directly (mirrors the spend-cap monitor):
   `update campaigns set status='paused', paused_at=now(), paused_reason='low_credits'
where status='active'` — capturing `id, owner_id, name` of each row flipped **this tick**
   for per-owner notifications.

6. **Resume (service-role, in the tick).** Replicates `resumeCampaign()`'s steps for each
   campaign we paused (`paused_reason='low_credits'`): set `status='active'`, clear
   `paused_at`/`paused_reason`, **then call `reapplyAgentIntegration(supabase, agent_id)`** to
   refresh the agent's post-call webhook (skipping this is how campaigns drift to a dead
   webhook). Only touches `paused_reason='low_credits'` rows — a teammate's manually paused or
   ended campaign is never auto-resumed.

7. **Notifications** — insert into `notifications` (`{ user_id, kind, message, ref_table,
ref_id }`), surfaced in the existing top-bar notification bell:
   - Warn (admins): one row per admin (`profiles.role='admin' and active`), `kind:
'elevenlabs_credits_low'`.
   - Stop (owners): one row per paused campaign to its `owner_id`, `kind:
'campaign_paused_low_credits'`, `ref_table:'campaigns'`, `ref_id: campaign.id`.
   - Stop (admins): one workspace row per admin, `kind: 'dialer_paused_low_credits'` (fires
     once on entering `low`).
   - Resume (owners + admins): `kind: 'campaign_resumed_credits_restored'` /
     `'dialer_resumed_credits_restored'`.
   - Plus a `system_events` audit row on each state transition
     (`kind: 'elevenlabs_credits_<state>'`, `actor_user_id: null`).

8. **Config** — thresholds via the `envNum` pattern in `src/lib/costs/rates.ts` (or a small
   `src/lib/elevenlabs/credit-thresholds.ts`).

9. **New block reason** `low_credits` — added to the `PreCallReason` union
   (`src/lib/dialer/queue.ts:32`) for the `TickSummary` only. (No change to the SQL
   `pre_call_check` — campaigns are paused, so its existing `campaign_not_active` already
   covers the per-lead path.)

### Migration

- `elevenlabs_credit_status` table (single row; additive).
- Extend `campaigns.paused_reason` CHECK to allow `'low_credits'`
  (currently `'manual' | 'daily_spend_cap' | 'monthly_spend_cap' | 'auto'`). Additive; applied
  before the code that writes it deploys.
- Applied with `supabase db push --linked`.

## Testing

Constraint (Marija's rule): **no live external test-writes** — we must never drain real EL
credits or place real calls to test this.

- **Unit-test `evaluateCreditState`** exhaustively (pure, no I/O): ok→warn→low→resume, hysteresis
  between STOP and RESUME, no warn-alert on the resume path, boundary values, undefined
  prevState.
- **Unit-test `enforceElevenLabsCreditGate`** with a mocked `getElevenLabsCreditBalance` and a
  fake Supabase client: verify pause set built from active campaigns, per-owner + admin
  notifications, resume touches only `low_credits` rows, fail-open on `null` read (no pause, logs
  event), transition-only notifications (no spam while staying low).
- **Verify locally** with `tsc` / `build` / `eslint` (CI Playwright was removed — no automated
  gate).
- **Manual smoke on prod:** temporarily set `EL_CREDIT_WARN_THRESHOLD` absurdly high so a
  healthy balance reads as "warn", confirm the admin notification appears in the bell, then
  restore the default. (Does not touch real credits.)

## Out of scope (v1)

- No per-user credit allocation (the pool is shared; not a real concept).
- No email/SMS alerts — in-app notification bell + `system_events` only.
- No separate always-on monitor cron — the tick's ~1/min cadence covers the goal (credits only
  drain while dialing). Can be added later if we want warnings while the dialer is idle.
- No warn-level hysteresis (only low↔resume). Add later only if flapping is observed.

## Rollout

1. Migration (table + CHECK) via `supabase db push --linked`.
2. Merge the code (one PR).
3. Confirm defaults in Vercel env are unset (defaults apply) or set intentionally.
4. Watch for the first `system_events` `elevenlabs_credits_*` rows and the daily outcome audit's
   existing credit check to confirm the numbers line up.
