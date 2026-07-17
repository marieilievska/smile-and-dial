# Shared Lists via Lead Ownership — Design

**Date:** 2026-07-17
**Status:** Approved by Marija (design conversation, 2026-07-17)

## Context & goal

Today one lead list can be attached to **at most one active campaign** — a hard
database rule (`list_campaign_active_unique`, a partial unique index from
migration `20260525150851`). Even the two back-door targeting paths that _can_
overlap (a campaign's company-name `audience_search` filter and its
`smart_list_id`) are collapsed by the `dial_queue` view so that when two
campaigns match the same lead, exactly one campaign (the oldest by
`created_at`) gets it and the others silently receive **zero** leads for the
overlap — not a double-call, but not sharing either.

Marija wants to point **multiple campaigns / agents at one big list** so it gets
worked faster (or split across different agents), **without ever double-calling
a lead**. Each lead should be called once, by whichever campaign reaches it
first, and then belong to that campaign for the rest of its life.

This is achievable as a **contained** change because of one key fact: a lead's
progress state (`status`, `next_call_at`, `retry_counter`, `retry_position`,
`resting_until`, conversation summary) lives in a single place, on the lead. As
long as each lead is only ever worked by **one** campaign, that single shared
state stays correct and the retry engine needs no changes. So the whole feature
reduces to: **record which campaign owns a lead, and let un-owned leads be
claimed first-come-first-served by any matching campaign.**

## Decisions made (design conversation)

| Question                                                          | Decision                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How is a shared lead treated?                                     | **Split the list — one call per lead, total.** Every lead is worked by exactly one of the sharing campaigns.                                                                                                                                      |
| Who makes a lead's follow-up calls?                               | **Sticky ownership** — the first campaign to dial a lead owns it for its entire lifecycle (every retry, callback, resting-redial).                                                                                                                |
| How are leads divided among sharing campaigns?                    | **First-available wins** — un-dialed leads sit in a shared pool; whichever campaign has a free line pulls the next one. No pre-assignment, no proportion knobs.                                                                                   |
| Does ownership apply to company-filter / smart-list overlaps too? | **Yes — universal.** Ownership governs every way a campaign matches a lead (list attachment, `audience_search`, `smart_list_id`). This also replaces the old "oldest wins, rest starve" behavior for those overlaps with first-available sharing. |

## The core mechanism

### 1. A lead gains an owner

New nullable column **`leads.owner_campaign_id uuid references campaigns(id) on
delete set null`**. `NULL` = un-owned (in the shared pool). Once set, the lead
belongs to that campaign forever (until explicitly released — see Edge cases).

`ON DELETE SET NULL` means deleting a campaign automatically returns its owned
leads to the pool (mirrors how `calls.campaign_id` already nulls on campaign
delete, migration `20260612190000`).

### 2. Ownership is stamped by the existing dial-time claim

The dialer already performs an atomic "grab" right before placing a call, to
stop the same lead being dialed twice concurrently — `claimLeadForDial` in
`src/lib/dialer/tick.ts:183-209`, a compare-and-swap that leases
`leads.next_call_at` into the future _only if_ the lead is still due. Exactly one
concurrent caller can win that row write.

We extend that one write to also stamp ownership, and to refuse a lead already
owned by someone else:

```sql
update leads
set next_call_at = :lease,
    owner_campaign_id = coalesce(owner_campaign_id, :campaign_id)
where id = :lead_id
  and (next_call_at is null or next_call_at <= :now)
  and (owner_campaign_id is null or owner_campaign_id = :campaign_id)
returning id
```

The claim wins iff the lead is **still due** AND **(un-owned OR already mine)**.
On a first win it stamps the owner; a retry by the same owner keeps it; a claim
by any other campaign matches zero rows and is skipped. Postgres serializes the
row write, so if two campaigns reach for the same un-owned lead in the same
instant, one becomes owner and the other finds it taken. **This single atomic
statement is the entire double-call guarantee** — no new locks, no new race
surface. `claimLeadForDial` gains a `campaignId` parameter (already available on
each `dial_queue` row the tick reads).

### 3. The queue surfaces un-owned leads to all matching campaigns

The `dial_queue` view (current definition in
`supabase/migrations/20260713120000_lead_line_type_mobile_lock.sql:21-108`)
currently ends with `select distinct on (q.lead_id) … order by q.lead_id,
q.dial_priority, q.campaign_created_at, q.campaign_id` — the "one winner per
lead, oldest campaign" collapse. Two changes:

1. **Add an ownership predicate** to the lead↔campaign join so an owned lead is
   only visible to its owner:
   `and (l.owner_campaign_id is null or l.owner_campaign_id = c.id)`
2. **Drop the `distinct on (q.lead_id)` collapse.** An owned lead now naturally
   produces exactly one row (only its owner passes the predicate); an un-owned
   lead produces one row **per matching active campaign**, so first-available
   can claim it.

A list attached to a single campaign behaves exactly as today (one match → one
row). The only behavioral change is for genuinely shared/overlapping leads,
which is the point.

**Interaction with a paused owner:** a paused campaign fails the view's
`c.status = 'active'` filter, so its owned leads produce no row and simply wait —
and because they carry `owner_campaign_id`, the ownership predicate keeps every
_other_ campaign from claiming them. The lead is held for the owner until it
resumes. This is the intended "sticky, but idle while owner is paused" behavior.

**Throughput note (accepted):** because an un-owned lead can appear as several
rows (one per sharing campaign) and the tick reads a fixed `limit` (default 50)
of queue rows, a heavily-shared pool of never-dialed leads yields fewer distinct
leads per tick than 50. At the platform's scale (hundreds–low-thousands of leads
per owner) this is negligible; the real limiter is the per-owner concurrency cap.
The tick `limit` is a tunable if it ever matters. No change for v1.

### 4. Nothing else needs to change

Because ownership makes each lead single-campaign, the retry engine
(`src/lib/dialer/retry-engine.ts`, writes lead state by `lead_id`),
`pre_call_check`'s per-lead in-flight guard and per-campaign caps, and the
per-owner pooled concurrency cap all keep working unchanged. Sharing campaigns
already share one owner-level concurrency budget (`pre_call_check` counts active
calls by `owner_id`), and each keeps its own hourly/daily pace caps.

## Edge cases

- **Campaign paused:** stops pulling new leads; **keeps** its owned leads (they
  wait for resume). Other sharing campaigns keep working the pool. To free a
  paused campaign's leads, detach the list from it.
- **Campaign deleted:** `ON DELETE SET NULL` returns its owned leads to the pool
  for the remaining campaigns.
- **List detached from one sharing campaign** (`src/lib/campaigns/list-attachments-actions.ts`):
  release that campaign's **non-terminal** owned leads in that list back to the
  pool, so the remaining campaigns can finish them:
  ```sql
  update leads
  set owner_campaign_id = null
  where owner_campaign_id = :campaign_id
    and list_id = :list_id
    and status in ('ready_to_call', 'callback', 'resting')
  ```
  Terminal leads (`goal_met`, `sale`, `dnc`, `closed`, `attended`, `no_show`,
  `email_replied`) keep their owner for history.
- **Lead reaches a terminal state:** done, never re-dialed; owner retained for
  the record.
- **Manual "Call Now" / browser dial:** if the lead is owned, the call goes out
  under its owning campaign (no picker). If it's un-owned in a multi-campaign
  list, the existing multi-campaign picker (`callNowFromLead` → `needsPicker`,
  `src/lib/dialer/call-now.ts:350-409`) prompts for the campaign, and that choice
  stamps ownership via the same `coalesce` claim so it sticks.
  `resolveHumanCallTarget` (`src/lib/twilio/human-call.ts:59-105`) becomes
  ownership-aware for the same reason. (Pre-existing gaps in the browser-dial
  path — no `pre_call_check`, `.find()` campaign resolution — are out of scope
  beyond making it respect ownership.)

**Known limitation (accepted for v1):** ownership is released on **detach** and
**campaign delete**. If an admin instead edits a campaign's `audience_search` or
`smart_list_id` so it no longer matches a lead the campaign already owns, that
lead can be left owned-but-idle (its owner no longer surfaces it, and the
ownership predicate keeps others out) until the campaign is deleted or the lead
is manually reassigned. This is a rare admin action; a self-healing "release
ownership when the owner no longer matches" pass is a possible later
enhancement, not v1.

## One-time backfill

Every lead that has already been dialed gets its owner set to the campaign of
its **most recent** call, so in-progress leads stay glued to the campaign
already working them and can't be scooped when a list is later shared:

```sql
update leads l
set owner_campaign_id = mr.campaign_id
from (
  select distinct on (lead_id) lead_id, campaign_id
  from calls
  where campaign_id is not null
  order by lead_id, created_at desc
) mr
where mr.lead_id = l.id
  and l.owner_campaign_id is null
```

Guarded to only-null owners and only leads with a campaign-attributed call.
Because lists are currently exclusive (one campaign each), this simply formalizes
the ownership that already exists in practice. **The current state (how many
leads have calls, how many distinct owning campaigns) will be read and shown
before this write runs**, per the production-data-edit rule.

## Removing the exclusivity constraint

Drop the partial unique index `list_campaign_active_unique` (migration
`20260525150851`) so a list can attach to multiple active campaigns. The attach
action (`src/lib/campaigns/list-attachments-actions.ts`) stops treating a second
active attachment as an error; instead it shows a short confirmation: _"This list
is shared — each lead is called once, by whichever campaign reaches it first."_
Relaxing a uniqueness rule only permits more; it cannot break existing
single-campaign lists. The `callNowFromLead` picker already handles "more than
one active campaign attached," so nothing downstream assumes exclusivity in a way
that breaks.

## UI

- **Attach flow:** allow attaching a list already on another active campaign;
  show the shared-list confirmation note above.
- **Campaign view:** a light indicator — _"Shared list · N leads owned here."_
- **Lead detail:** _"Owned by: [campaign]."_
- Light-touch for v1 — enough to confirm the split is working; no new dashboards.

## Safety & rollout

- `leads.owner_campaign_id` is an additive nullable column — safe to apply to
  the live database ahead of the code deploy (per the migration-sequencing rule).
- Dropping the exclusivity index relaxes a constraint — safe.
- The `dial_queue` view change and the `claimLeadForDial` extension ship
  together in the code deploy; the view is replaced with `create or replace`.
- Backfill runs after the column exists, before/at deploy, with the pre-read
  shown to Marija.
- This system places real phone calls (money + TCPA): the double-call guarantee
  rests entirely on the atomic claim in §2, which is covered by the tests below.

## Testing

- **Playwright** (`tests/`): two active campaigns sharing one seeded list, with
  seeded leads. Assert: (a) after ticks, every lead has exactly one call and a
  stamped `owner_campaign_id`; (b) an owned lead is never claimed by the other
  campaign; (c) un-owned leads distribute across both campaigns; (d) detaching
  the list from one campaign releases its non-terminal leads to the other.
  (Specs run against the live environment — no CI gate; local `tsc`/`eslint`/
  `build` must be clean.)
- **Focused claim test:** the extended `claimLeadForDial` — an owned lead's claim
  by a non-owner returns false; an un-owned claim stamps the owner; a same-owner
  re-claim succeeds. Extract the claim predicate somewhere unit-testable if
  practical, else cover via the Playwright path.

## Out of scope (v1, deliberate)

- Pre-assigned / proportional splits (A gets 60%, B 40%; by territory). Rejected
  in favor of first-available.
- Non-sticky follow-ups (a lead's retries bouncing between campaigns). Rejected.
- Per-campaign copies of lead state / campaign-aware retry engine (only needed if
  each campaign worked the whole list — explicitly not the chosen model).
- Self-healing ownership release when a campaign's targeting changes (see Known
  limitation).
- Cross-owner list sharing (the whole model is scoped to one `owner_id`).

## Implementation pointers (for the plan)

- Migration: add `leads.owner_campaign_id` (+ index on it for the queue/claim);
  drop `list_campaign_active_unique`; `create or replace` `dial_queue` with the
  ownership predicate and without the `distinct on` collapse; backfill.
- `src/lib/dialer/tick.ts` — extend `claimLeadForDial` (add `campaignId`, stamp
  owner); pass the row's `campaign_id`.
- `src/lib/campaigns/list-attachments-actions.ts` — allow multi-attach; release
  ownership on detach.
- `src/lib/dialer/call-now.ts` + `src/lib/twilio/human-call.ts` — ownership-aware
  manual dial; stamp owner on manual dial.
- `src/lib/supabase/database.types.ts` — new column.
- UI: attach dialog note; campaign + lead-detail ownership indicators.
- Tests: `tests/shared-list-ownership.spec.ts` (+ any claim unit test).
