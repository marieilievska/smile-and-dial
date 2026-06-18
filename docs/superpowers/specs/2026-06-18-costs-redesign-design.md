# Costs page redesign (Phase 2 of the Costs overhaul)

**Date:** 2026-06-18
**Status:** Design — awaiting review
**Author:** Marija + Claude

Phase 2 of the Costs overhaul. Phase 1 (separate branch/PR) made the cost
_numbers_ correct. Phase 2 restyles and re-prioritizes the Costs **page** — a
modern "2026 AI, not 2016 SaaS" look — on top of the same (now-accurate) data.

## Approved direction

Marija approved the mockup direction: a calm, spacious dashboard whose modern
feel comes from hierarchy and restraint (big confident numbers, generous space,
one accent color, a soft trend chart) — **not** dark glass / neon. It reuses the
app's existing CSS-variable theme, so it adapts to light/dark and keeps the coral
accent.

Scope decision: **reskin + smarter layout** (not a from-scratch rebuild). All
existing functionality stays; the data layer is untouched.

Emphasis (Marija's picks), top to bottom:

1. **Total spend + trend** — the hero.
2. **Cost per result** — efficiency KPIs directly under the hero.
3. **Where the money goes** — vendor + campaign breakdown.
   Budget caps were **not** picked, so they're demoted (kept, but secondary).

## What stays exactly as-is (reused, not rebuilt)

- **The entire data layer:** `src/lib/analytics/costs.ts` (rollups,
  `pickBreakdown`, vendor/campaign/list/day/user) and
  `src/app/(app)/costs/stats-query.ts` (`fetchCostsHeadlineStats`,
  `fetchCampaignCaps`). No query or math changes.
- **All views:** Campaign / List / Per goal met / Day / Call (and the admin-only
  Per-user view), plus the per-call expandable table and CSV export.
- **Date-range pills**, the mock-data banner, and the budget **cap-alert banner**
  (safety info — kept, just restyled).
- **No new charting dependency.** The repo's charts are hand-rolled SVG
  (`per-time-chart.tsx`, the stat-strip sparkline). The hero trend reuses/extends
  that SVG area chart. (The brainstorm mockup used Chart.js only for speed.)

## Design — page composition (top to bottom)

1. **Header.** Title "Costs" + subtitle ("Last 30 days · N calls"), date-range
   pills, and Export — restyled to the new spacing/type scale. Keep the small
   "N campaigns near cap" chip here (links to the per-campaign view) instead of a
   full alert banner when nothing is critical; the full banner still appears when
   a cap is ≥90%.

2. **Hero card — total spend + trend (new component `costs-hero.tsx`).**
   - Big total spend for the range, the vs-previous-period delta (green when down,
     red when up), projected month-end, and today's spend.
   - A daily-spend area chart filling the card width (reuse/extend the existing
     SVG area chart from `per-time-chart.tsx` so there's one chart implementation).

3. **KPI strip (restyle `costs-stat-strip.tsx`).** Three metric cards:
   **Cost per goal met**, **Cost per call**, **Goals met** (count). (The current
   strip's "this month" + sparkline content moves into the hero, so the strip is
   purely the efficiency numbers. Talk-time cost is an optional swap for the third
   card if preferred — noted, not assumed.)

4. **Where the money goes (restyle `costs-vendor-breakdown.tsx`).** A single
   segmented spend bar + a vendor legend with $ and %: ElevenLabs (labelled
   **"voice + LLM"** to make the bundle explicit, per the Phase 1 decision),
   Twilio calls, Twilio lookup, Phone numbers, OpenAI. Same vendor data the card
   shows today, restyled.

5. **Top campaigns by spend (new small block, or fold into the breakdown card).**
   A compact bar list: campaign name, spend bar, spend, and cost/goal — sourced
   from the existing `rollupByCampaign`. Links to the per-campaign view / calls.

6. **View tabs + table (restyle `costs-view-tabs.tsx` + the per-view tables).**
   The segmented control and the Campaign/List/Goal/Day/Call tables stay, restyled
   to the new card/spacing/`tabular-nums` treatment for consistency. The per-time
   view uses the same SVG area chart as the hero.

**Responsive:** hero full-width; KPI strip 3-up (stacks to 1 on mobile); the
"where the money goes" card and "top campaigns" sit **side-by-side on wide
screens**, stacked on narrow. The mockup was squeezed to ~680px; the real page
uses the app's normal content width.

## Visual system

- Reuse the app's CSS variables / Tailwind tokens (`--card`, `--border`,
  `--muted-foreground`, `--primary` coral, etc.) — themes light/dark for free.
- Rounded cards (`rounded-xl`/`-2xl`), 0.5px borders, generous padding, large
  `tabular-nums` values, small uppercase muted labels. Two font weights.
- Coral as the single accent (trend line, bars, active pills). Vendor segments
  use a small fixed palette, each paired with a text label + % (never color
  alone).

## What does NOT change

- No data, query, or cost-math changes (that was Phase 1).
- No database migration; no server actions touched.
- No removed functionality — every view, the export, and cap safety info remain.

## Safety & rollout

- **Pure front-end.** No migration, no data edits, no API/route changes.
- **Contract test:** the Costs page has no behavioral logic change; if a Costs
  Playwright smoke test exists, adjust any selectors the restyle renames,
  otherwise no new spec is required. (Specs run live only.)
- **Local verification:** `npx tsc --noEmit`, `npx eslint` on changed files, and
  `npm run build` clean before merge.
- **Deploy:** branch `feat/costs-redesign` → PR → merge to main (Vercel
  auto-deploys). Independent of the Phase 1 PR.

## Out of scope

- New metrics or cost categories beyond what exists today.
- A charting library / new chart types beyond the existing SVG area chart + bars.
- Per-call ElevenLabs voice/LLM split (impossible; Phase 1 decision).
