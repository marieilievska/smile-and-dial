# Split `hung_up_immediately` into immediate vs later — design spec

**Date:** 2026-08-11
**Status:** Approved, ready for implementation

## Problem

Today there is a single `hung_up_immediately` outcome, set two ways:

1. The agent's `disposition=hung_up` (any duration — the agent applies it to 130s
   calls too, despite its prompt defining it as "first few seconds").
2. A fallback heuristic: a `≤20s`, remote-party-ended call whose outcome would
   otherwise be blank/gatekeeper.

So a 3-second brush-off and a 90-second "listened to the pitch, then hung up" call
land in the same bucket. They're different signals — one is a robocall-reflex
hangup, the other is an engaged prospect the pitch lost.

## The split

Add a second outcome, **`hung_up_later`** (label "Hung up later"). Whenever a call
resolves to a hang-up, classify by **engagement + time**:

- **`hung_up_immediately`** — the person gave **no genuine reply** AND the call was
  **≤15 seconds** (hung up during/right after the greeting).
- **`hung_up_later`** — any other hang-up: they said something back, or stayed on
  the line past 15s, then hung up.

"Genuine reply" reuses the existing `genuineHumanReplyCount()` (a short,
conversational, non-machine turn after the agent spoke). Threshold validated on
2026-08-10: of 361 real hang-ups, ~181 immediate / ~180 later — a clean, intuitive
split (immediate = 1–15s zero-reply; later = "Yeah bro, what's going on?",
"Nikola speaking, how can I help you?", "No sorry, I'm working, bye").

## Behavior / metrics

`hung_up_later` is treated exactly like `hung_up_immediately` everywhere **except**
it is its own labelled/coloured value and its own reporting column:

- **CONNECTED_OUTCOMES**: yes (a person answered). Counts toward connect rate.
- **CONVERSATION_OUTCOMES / NO_HUMAN_OUTCOMES**: no (not a real conversation, not a
  no-human) — same as immediate.
- **reachedHuman** (extraction mirroring): false — no real conversation, so we
  don't mirror the AI's guessed judgment fields. Same as immediate.
- **Retry** (`retry-engine`, `sync-next-call`): identical to immediate — retry the
  lead, and escalate a pending callback rather than orphaning it.
- **Colour** (`outcome-style`): amber (didn't connect / worth another try).

The agent prompt is **unchanged**: it keeps one `hung_up` disposition; we derive
immediate-vs-later ourselves from duration + engagement (more reliable than asking
the LLM to judge "how fast").

## Implementation

- **Migration** `20260811_add_hung_up_later_outcome.sql`: drop/recreate
  `calls_outcome_check` with `hung_up_later` added (additive; `leads.last_outcome`
  was dropped, so calls is the only constraint). Applied to prod **before** the
  code deploys and before backfill (else the new value violates the constraint).
- **`classify-outcome.ts`**: add `hangUpKind(durationSecs, humanReplies)`; after
  the outcome cascade, refine `if (outcome === "hung_up_immediately") outcome =
hangUpKind(...)`. Add `hung_up_later` to the `reachedHuman` exclusion.
- **`outcomes.ts`**: add to `OVERRIDABLE_OUTCOMES` + `CONNECTED_OUTCOMES`.
- **`labels.ts`**: "Hung up later". **`outcome-style.ts`**: amber set.
- **`retry-engine.ts`** (`RETRY_OUTCOMES`, `CALLBACK_NONCONNECT_OUTCOMES`) and
  **`sync-next-call.ts`** (`CALLBACK_NON_CONNECT_OUTCOMES`): add the value.
- **`agent-analytics/stats.ts`**: `hungUpLater` counter on `DailyKpi`.
- **Reporting `dashboard-view.tsx`**: a separate "Hung up late" column (header,
  cell, CSV column, export row) next to "Hung up".
- **`call-detail-modal.tsx`**: a `hung_up_later` case describing it.
- **Tests** (`classify-outcome.unit.test.ts`): boundary at 15s (0 replies @15s =
  immediate, @16s = later, any reply = later), plus the genuine short hang-up.

## Backfill

Relabel **only 2026-08-10 (ET)** `hung_up_immediately` rows by the new rule
(~180 → `hung_up_later`), `outcome_source='manual'`, guarded to rows still
`hung_up_immediately`. No history beyond yesterday.

## Out of scope

Renaming/merging the two in any UI other than Reporting; changing the agent
prompt; a "hung up mid-conversation" third tier.
