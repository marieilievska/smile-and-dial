# Single-Active-Dial Index — Design (shared-list fast-follow)

**Date:** 2026-07-17
**Status:** Approved by Marija (design conversation, 2026-07-17)
**Follows:** [`2026-07-17-shared-list-lead-ownership-design.md`](./2026-07-17-shared-list-lead-ownership-design.md)

## Context & goal

The shared-list ownership feature (PR #273) made each lead the property of exactly
one campaign, stamped atomically by `claim_lead_for_dial`. That atomic claim is the
double-call guarantee for the autopilot tick. But two narrow time-of-check /
time-of-use (TOCTOU) windows remain, all documented in the shared-list spec:

- **Pre-existing (same-campaign):** manual "Call Now" re-checks for an in-flight
  call, then inserts a `calls` row. A concurrent tick (or a second Call Now) can
  insert between that check and the insert. (`call-now.ts` already documents this.)
- **Known limitation 2 (cross-campaign):** a manual "Call Now" stamps ownership
  before dialing, but a tick for a _different_ campaign whose `claim_lead_for_dial`
  lands in the few-ms gap between Call Now's in-flight re-check and its ownership
  stamp could still dial.

Both are the same class: two **AI outbound** call-row inserts for one lead slipping
past an application-level check. The complete fix — already contemplated in
`call-now.ts` — is a **partial unique index on `calls(lead_id)` for active
statuses**, which makes a second concurrent active row a database error instead of
a second phone call. This system places real calls (money + TCPA), so closing the
window at the database level is worth the care.

**Scope chosen (design conversation):** the index covers **AI** outbound dials
(the autopilot tick + manual "Call Now"). The **human** browser-dial path is left
unchanged; its narrow window stays the documented, accepted **Known limitation 3**.

## The index

```sql
create unique index calls_one_active_ai_outbound_dial_per_lead
  on public.calls (lead_id)
  where direction = 'outbound'
    and call_mode = 'ai'
    and status in ('queued', 'dialing', 'ringing', 'in_progress');
```

Three predicate terms, each load-bearing:

| Term                     | Why                                                                                                                                                                                                                                                                                |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `direction = 'outbound'` | **Inbound calls insert `status = 'in_progress'`** (`inbound-webhook.ts` upsert). Without this term, a lead calling in while we are mid-dial to them would fail to be logged (23505) — breaking inbound routing. Inbound + outbound overlap is legitimate; it is not a double-dial. |
| `call_mode = 'ai'`       | Covers the tick and manual "Call Now" (both default `call_mode = 'ai'`). Excludes the human browser-dial path (`call_mode = 'human'`), per the chosen scope.                                                                                                                       |
| `status in (...)`        | The four in-flight statuses. Terminal rows (`completed`, `failed`, `cancelled`) are excluded, so a lead can accrue any number of _finished_ calls; only one may be _active_ at a time. Mock-mode inserts are `completed`, so dev/test are unaffected.                              |

**What it closes:** every AI-outbound-vs-AI-outbound race — tick vs tick, tick vs
"Call Now", "Call Now" vs "Call Now" — same-campaign and cross-campaign. This
retires the pre-existing same-campaign TOCTOU and shared-list Known limitation 2.

**What it deliberately does not touch:** inbound routing (`direction`) and human
browser-dial (`call_mode`). Known limitation 3 remains open and accepted.

### Concurrency & table size

The migration uses a **non-concurrent** `CREATE UNIQUE INDEX`. The `calls` table is
small (low thousands of rows lifetime; the active-AI-outbound subset is a handful at
any instant). A plain build takes a `SHARE` lock — blocks writes, not reads — for
milliseconds. `CREATE INDEX CONCURRENTLY` cannot run inside a migration transaction
and buys nothing at this size; a failed concurrent build would also leave an
`INVALID` index to clean up. Non-concurrent keeps the dedup + index creation in one
atomic transaction.

## Reconcile first (production-data safety)

A unique-index build **fails outright** if duplicate rows already violate the
predicate. So before the index is created:

1. **Read-only pre-check, shown to Marija.** Query prod for any lead with more than
   one active AI-outbound `calls` row, plus an overview of current active rows. Read
   via the pg session pooler + `SUPABASE_DB_PASSWORD` (see memory
   `reference_supabase_access`). No write happens until Marija has seen the exact
   rows (production-data-edit rule).

2. **Guarded, deterministic dedup inside the migration** (race-proof safety net). If
   any lead still has more than one such row when the migration runs, keep the row
   that actually placed a call (`twilio_call_sid is not null` first, then newest by
   `created_at`, `id`) and terminalize the rest — mirroring `closeStaleActiveCalls`:

   ```sql
   with ranked as (
     select id,
            row_number() over (
              partition by lead_id
              order by (twilio_call_sid is not null) desc, created_at desc, id desc
            ) as rn
       from public.calls
      where direction = 'outbound'
        and call_mode = 'ai'
        and status in ('queued', 'dialing', 'ringing', 'in_progress')
   )
   update public.calls c
      set status = 'failed',
          outcome = coalesce(c.outcome, 'failed'),
          ended_at = coalesce(c.ended_at, now())
     from ranked r
    where c.id = r.id
      and r.rn > 1;
   ```

   If the manual reconcile already cleared everything (the expected case), this is a
   no-op. The dedup and the `CREATE INDEX` run in the same migration transaction, so
   the index can never be built against un-reconciled data.

`closeStaleActiveCalls` already runs on every tick and every "Call Now", so stuck
rows older than 15 min (AI) are continuously reaped in prod independent of this work;
the migration dedup only has to handle genuinely-fresh duplicates, which the index
then makes impossible going forward.

## Code changes

Three edits, all in the two AI insert paths, using the codebase's existing
`(error as { code?: string }).code === "23505"` idiom.

### 1. `src/lib/dialer/call-now.ts` — manual "Call Now" (live path)

- **Catch `23505` on the pending-row insert** → return the existing
  _"This lead already has a call in progress."_ copy (the `call_in_flight` label),
  instead of the generic _"Could not record the call before dialing."_.
- **Fix a latent ownership leak.** Today, if that insert fails _after_ the code has
  optimistically stamped `owner_campaign_id` (the `stampedHere` branch), ownership
  is never released — only the later _placement_ failure releases it. Release
  ownership on insert failure too, guarded by `stampedHere` and
  `.eq("owner_campaign_id", input.campaignId)` so it never clears a pre-existing
  owner. With the index in place, a lost-race insert (23505) is precisely when this
  path fires.

### 2. `src/lib/dialer/call-now.ts` — server-side non-owner reject

`callNow` currently trusts the `campaignId` it is handed. Add: after loading the
lead (extend the select to include `owner_campaign_id`), if the lead is owned by a
**different** campaign than `input.campaignId`, reject with
_"This lead is owned by another campaign."_ Un-owned (`null`) and same-owner both
pass. `callNowFromLead` already routes owned leads to their owner, so this guard
protects **direct** `callNow` callers (e.g. the lead-detail Call dialog passing an
explicit campaign) — the gap where "the UI only hides it".

### 3. `src/lib/dialer/tick.ts` — autopilot live path (`placeLiveDialerCall`)

- **Catch `23505` on the pending-row insert** → treat as **blocked / already in
  flight**, not an error. The lead was already claimed (its `next_call_at` is leased
  2 min out), so it is not re-dialed immediately; ownership is already consistent (a
  successful claim is the gate), so no rollback is needed here.
- **Small return-type change** so the caller can distinguish "dialed" / "already in
  flight (blocked)" / "error" and record it honestly in `TickSummary.blockedReasons`
  (e.g. `already_in_flight`) rather than inflating `errors`.

The mock paths (`placeMockCall`, Call Now mock) insert `completed` rows and never
touch the index — no change. The human path (`createHumanCallRow`, `call_mode =
'human'`) and inbound (`inbound-webhook.ts`, `direction = 'inbound'`) are both
excluded by the predicate — no change, no forced error-handling.

## Testing

Specs run against the live environment (no CI gate); local `tsc` / `eslint` / `build`
must be clean.

- **Index scope spec** (`tests/single-active-dial-index.spec.ts`): seed a lead;
  insert one active AI-outbound `calls` row; assert a **second** active AI-outbound
  insert for the same lead is rejected with `23505`; and assert that, for the same
  lead, each of these still succeeds (proving the predicate's scope):
  - a `completed` outbound AI row (terminal status),
  - an `in_progress` **inbound** row (different direction),
  - a `dialing` **human** row (different call_mode).
    Clean up seeded rows.
- **Call-Now non-owner reject:** a lead owned by campaign A, called via `callNow`
  with campaign B, returns the owned-by-another-campaign error and places no call.

## Rollout sequence

Code-first, so the index never lands ahead of the code that handles it:

1. Reconcile read → **show Marija** the active-row / duplicate counts.
2. Merge the PR → Vercel deploys the 23505-handling code.
3. `supabase db push` → runs the guarded dedup + creates the index (one transaction).

The additive column work from the shared-list feature is already live; this
migration only adds an index (plus the guarded one-time dedup), so there is no
column-drop / rename sequencing hazard.

## Out of scope (deliberate)

- **Human browser-dial ownership stamp + refuse-on-race** (Known limitation 3). The
  index is `call_mode = 'ai'`, so the human path is untouched; its narrow window
  stays the documented, accepted limitation. Revisit only if human browser-dialing
  is actually used on a shared list.
- **Inbound participation.** Inbound is legitimately concurrent with an outbound
  dial and must never be blocked from logging.
- **A `CONCURRENTLY` / out-of-band build.** Unnecessary at the `calls` table's size.

## Implementation pointers (for the plan)

- Migration `supabase/migrations/20260717130000_calls_single_active_ai_dial_index.sql`:
  guarded dedup CTE (above) → `create unique index ... where direction='outbound' and
call_mode='ai' and status in (...)` → `comment on index`.
- `src/lib/dialer/call-now.ts` — 23505 handling + ownership release on insert
  failure; `owner_campaign_id` in the lead select + non-owner reject.
- `src/lib/dialer/tick.ts` — `placeLiveDialerCall` 23505 handling + return-type tweak
  - call-site accounting into `blockedReasons`.
- `tests/single-active-dial-index.spec.ts` — scope spec + non-owner reject.
- Update `2026-07-17-shared-list-lead-ownership-design.md`: note the fast-follow
  index shipped, closing the pre-existing TOCTOU and Known limitation 2; limitation 3
  intentionally left open.
- No `database.types.ts` change (index only; `owner_campaign_id` already typed).
