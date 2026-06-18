# Analytics page redesign + per-business funnel

**Date:** 2026-06-18
**Status:** Design — awaiting review
**Author:** Marija + Claude

A "2026, not 2016" redesign of the Analytics page (same treatment as the Costs
page), built around a clean **per-business conversion funnel** as the hero. Two
definition fixes go with it; the rest is a visual reskin reusing the existing
data layer and hand-rolled SVG charts (no new dependency).

## Approved direction

The conversion funnel is the hero: **Called → Connected → Conversations →
DMs reached → Goals met**, narrowing cleanly, with step-conversion at each stage
and the rates pulled out beneath. Calm, spacious, one accent color — themes
light/dark via the app's tokens.

## Decisions (locked in)

- **Funnel is per business (distinct lead), not per call.** Each stage counts the
  unique leads that reached it, so it narrows into a true funnel. (Per-call counts
  let later sticky-flag stages exceed earlier ones — a broken-looking funnel.)
- **Conversations = talk time > 1 minute** (`talk_time_seconds >= 60`), replacing
  the current outcome-based "Conversation" definition.
- **Reuse the data rows** — `fetchCallsForRange()` already returns per-call rows
  with `lead_id`, `outcome`, `goal_met`, `talk_time_seconds`, and the joined
  sticky `lead_decision_maker_reached` flag (commit #145). No query change needed.
- **No new charting dependency** — funnel + charts stay hand-rolled SVG / divs.
- **Keep the existing date pills, filters (campaign/list/owner), and
  compare-to-prior-period.**

## Funnel stage definitions (distinct `lead_id` within the date range)

| Stage             | A lead counts when it has…                   |
| ----------------- | -------------------------------------------- |
| **Called**        | ≥1 call in range                             |
| **Connected**     | ≥1 call whose `outcome` ∈ CONNECTED_OUTCOMES |
| **Conversations** | ≥1 call with `talk_time_seconds >= 60`       |
| **DMs reached**   | `lead_decision_maker_reached = true`         |
| **Goals met**     | ≥1 call with `goal_met = true`               |

Step conversion shown between stages: connect rate = connected/called,
conversation rate = conversations/connected, DM-reach = dmsReached/conversations,
goal rate = goalsMet/dmsReached; plus the overall dial→goal rate.
(Stages are computed independently per lead; in normal data each nests inside the
prior. A rare data quirk could make a later stage marginally exceed an earlier
one — acceptable and far cleaner than the per-call version.)

## Design — page composition (top to bottom)

1. **Header** — "Analytics" + subtitle (range, N businesses dialed), date pills,
   filters, compare toggle. Restyled.
2. **Conversion funnel hero (new `analytics-funnel.tsx`)** — the 5 stages as
   horizontal bars (width ∝ share of "called"), each with its count and
   step-conversion %; goals-met stage in green. Replaces the current per-call
   `FunnelChart` in the hero slot.
3. **Rate strip** — four tiles: connect rate, conversation rate, DM-reach rate,
   goal rate (the step conversions), goal rate in green.
4. **Activity over time** (restyled `activity-over-time.tsx`) — goals met / calls
   by day, the existing switchable SVG area chart.
5. **Supporting row** — **campaign leaderboard** and **outcome breakdown**
   side-by-side; the outcome breakdown **recolored to the new green/amber/red
   tiers** shipped in PR #153 for consistency.
6. **Best-time heatmap** (kept, restyled) and the **insight line**, which now
   reads the per-business funnel to name the biggest drop-off.

**Responsive:** funnel + rate strip full width; supporting charts 2-up on wide,
stacked on narrow. Real content width (the mockup was squeezed to ~680px).

## Data layer

- Add `buildLeadFunnel(rows)` to `src/lib/analytics/stats.ts`: returns the 5
  distinct-lead stage counts above + the derived step rates. Add a small
  `talk_time_seconds >= 60` helper for the conversations stage.
- Keep `computeKpis()` for the secondary numbers it still feeds (cost per goal,
  avg call, inventory tile, spend) — those are legitimately per-call and unchanged.
- Point the funnel viz and the insight at `buildLeadFunnel`.

## Visual system

Reuse the app tokens (`bg-card`, `border-border`, `--primary` accent, `success`
green), big `tabular-nums`, small uppercase labels, rounded cards, 0.5px borders,
two font weights. One accent for the funnel bars; goals-met highlighted green.

## What does NOT change

- The `calls`/`leads` schema, the `fetchCallsForRange` query, date logic, and
  filters are untouched. No migration, no data edits, no server-action changes.
- No removed analytics capability — every existing section is kept (restyled) or
  upgraded; nothing is dropped.

## Safety & rollout

- **Front-end + analytics aggregation only.** No DB/migration/data changes.
- **Contract test:** if an analytics Playwright spec asserts a funnel selector or
  the old conversation count, update it; the funnel becomes per-lead and
  conversations becomes talk-time-based. (Specs run live only.)
- **Local verification:** `npx tsc --noEmit`, `npx eslint` changed files,
  `npm run build` clean.
- **Deploy:** branch `feat/analytics-redesign` → PR → merge to main (auto-deploys).

## Out of scope

- New analytics metrics beyond the funnel + existing sections.
- A charting library / new chart types beyond the existing SVG/div patterns.
- Per-call vs per-lead toggle (funnel is per-business; raw call volume still lives
  in the secondary KPIs).
