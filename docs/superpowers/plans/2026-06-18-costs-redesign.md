# Costs Page Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle and re-prioritize the Costs page into a modern, spacious dashboard — spend-trend hero, cost-per-result KPIs, a colored "where the money goes" breakdown, and top campaigns — reusing the existing data layer and charts (no new dependency).

**Architecture:** Pure front-end. New `costs-hero.tsx`, `costs-kpi-strip.tsx`, and `costs-top-campaigns.tsx` components; a restyled `costs-vendor-breakdown.tsx`; and a recomposed `page.tsx`. The old `costs-stat-strip.tsx` and `costs-insight.tsx` are removed (their content is replaced by the hero + KPI strip). All cost data/queries/rollups are untouched.

**Tech Stack:** Next.js (App Router, server components), Tailwind v4 with CSS-variable theme tokens, hand-rolled SVG charts.

---

## Conventions for this plan

- **No CI gate / Playwright runs live only.** "Verify" each task = `npx tsc --noEmit` + `npx eslint <files>` clean; `npm run build` clean at the end. Don't run `npx playwright test` locally.
- **Branch:** `feat/costs-redesign` (already created off main). Stage only the files each task names.
- **No data/query/server changes** — front-end only.
- Reuse existing tokens: `bg-card`, `border-border`, `text-foreground`, `text-muted-foreground`, `text-success`, `text-destructive`, `var(--primary)`. Two font weights (normal/medium). `tabular-nums` on numbers.

---

### Task 1: Hero card — total spend + trend

**Files:**

- Create: `src/app/(app)/costs/costs-hero.tsx`

- [ ] **Step 1: Write the component**

Create `src/app/(app)/costs/costs-hero.tsx`:

```tsx
import { TrendingDown, TrendingUp } from "lucide-react";

function usd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `$${value.toFixed(2)}`;
}

/** Hero card: total spend for the range, the vs-previous-period delta (down is
 *  good on a cost page), the month-end projection + today's spend, and a static
 *  daily-spend area chart. Plain SVG (same approach as PerTimeChart) so no
 *  charting dependency is added. */
export function CostsHero({
  total,
  spendDelta,
  projectedMonthSpend,
  todaySpend,
  daily,
}: {
  total: number;
  spendDelta: number | null;
  projectedMonthSpend: number;
  todaySpend: number;
  daily: number[];
}) {
  const width = 720;
  const height = 132;
  const padding = 14;
  const innerW = width - padding * 2;
  const innerH = height - padding * 2;
  const max = Math.max(0.01, ...daily);
  const step = daily.length > 1 ? innerW / (daily.length - 1) : 0;
  const points = daily
    .map((v, i) => {
      const x = padding + i * step;
      const y = padding + (innerH - (v / max) * innerH);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const filled =
    daily.length > 1
      ? `${padding},${height - padding} ${points} ${padding + (daily.length - 1) * step},${height - padding}`
      : "";

  const down = spendDelta != null && spendDelta < 0;
  const deltaPct = spendDelta == null ? null : Math.abs(spendDelta * 100);

  return (
    <section
      data-testid="costs-hero"
      className="border-border bg-card rounded-2xl border p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-muted-foreground text-[11px] font-medium tracking-[0.14em] uppercase">
            Total spend
          </p>
          <div className="mt-1.5 flex items-baseline gap-3">
            <span className="text-foreground text-4xl leading-none font-medium tabular-nums">
              {usd(total)}
            </span>
            {deltaPct != null ? (
              <span
                className={`inline-flex items-center gap-1 text-sm ${down ? "text-success" : "text-destructive"}`}
              >
                {down ? (
                  <TrendingDown className="size-4" />
                ) : (
                  <TrendingUp className="size-4" />
                )}
                {deltaPct.toFixed(1)}%
              </span>
            ) : null}
          </div>
          <p className="text-muted-foreground mt-1.5 text-xs">
            vs the prior period
          </p>
        </div>
        <div className="text-right">
          <p className="text-muted-foreground text-[11px] font-medium tracking-[0.14em] uppercase">
            Projected month-end
          </p>
          <p className="text-foreground mt-1.5 text-xl font-medium tabular-nums">
            {usd(projectedMonthSpend)}
          </p>
          <p className="text-muted-foreground mt-1.5 text-xs tabular-nums">
            {usd(todaySpend)} today
          </p>
        </div>
      </div>
      <div className="mt-5">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="h-32 w-full"
          role="img"
          aria-label="Daily spend across the selected range"
          style={{ color: "var(--primary)" }}
        >
          <defs>
            <linearGradient id="hero-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity={0.24} />
              <stop offset="100%" stopColor="currentColor" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          {daily.length > 1 ? (
            <>
              <polygon points={filled} fill="url(#hero-area)" />
              <polyline
                points={points}
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </>
          ) : null}
        </svg>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit && npx eslint "src/app/(app)/costs/costs-hero.tsx"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/costs/costs-hero.tsx"
git commit -m "feat(costs): spend + trend hero card" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Cost-per-result KPI strip

**Files:**

- Create: `src/app/(app)/costs/costs-kpi-strip.tsx`

- [ ] **Step 1: Write the component**

Create `src/app/(app)/costs/costs-kpi-strip.tsx`:

```tsx
import { PhoneCall, Target, Trophy } from "lucide-react";

function usd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `$${value.toFixed(2)}`;
}

/** Three efficiency KPIs under the hero: cost per goal met, cost per call, and
 *  goals met (with conversion rate). Values are computed on the page. */
export function CostsKpiStrip({
  perGoal,
  perCall,
  goalMet,
  totalCalls,
}: {
  perGoal: number | null;
  perCall: number;
  goalMet: number;
  totalCalls: number;
}) {
  const rate = totalCalls === 0 ? 0 : Math.round((goalMet / totalCalls) * 100);
  return (
    <section
      data-testid="costs-kpi-strip"
      className="grid grid-cols-1 gap-4 sm:grid-cols-3"
    >
      <Kpi
        icon={<Target className="size-3.5" />}
        label="Cost per goal met"
        value={perGoal == null ? "—" : usd(perGoal)}
        sub={`${goalMet.toLocaleString()} goals met`}
      />
      <Kpi
        icon={<PhoneCall className="size-3.5" />}
        label="Cost per call"
        value={usd(perCall)}
        sub={`${totalCalls.toLocaleString()} calls`}
      />
      <Kpi
        icon={<Trophy className="size-3.5" />}
        label="Goals met"
        value={goalMet.toLocaleString()}
        sub={`${rate}% of calls`}
      />
    </section>
  );
}

function Kpi({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="border-border bg-card flex flex-col gap-1 rounded-xl border p-5">
      <p className="text-muted-foreground inline-flex items-center gap-1.5 text-[10px] font-medium tracking-[0.16em] uppercase">
        <span className="text-primary">{icon}</span>
        {label}
      </p>
      <p className="text-foreground text-2xl leading-none font-medium tabular-nums">
        {value}
      </p>
      <p className="text-muted-foreground text-[11px] tabular-nums">{sub}</p>
    </div>
  );
}
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit && npx eslint "src/app/(app)/costs/costs-kpi-strip.tsx"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/costs/costs-kpi-strip.tsx"
git commit -m "feat(costs): cost-per-result KPI strip" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Restyle the vendor breakdown (colored segmented bar)

**Files:**

- Modify: `src/app/(app)/costs/costs-vendor-breakdown.tsx` (full rewrite)

- [ ] **Step 1: Replace the whole file**

Replace the entire contents of `src/app/(app)/costs/costs-vendor-breakdown.tsx` with:

```tsx
import { Phone } from "lucide-react";

import type { rollupByVendor } from "@/lib/analytics/costs";

function usd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `$${value.toFixed(2)}`;
}

/** Per-vendor cost breakdown — a single segmented spend bar plus a legend with
 *  $ and %. Each vendor has a fixed colour (paired with its name + % in the
 *  legend, so colour is never the only cue). Phone-number rental is a flat
 *  monthly fee billed separately, shown on its own line below a divider and NOT
 *  folded into the per-call vendor total. */
export function CostsVendorBreakdown({
  summary,
  extraLookupCost = 0,
  monthlyNumberCost = 0,
  numberCount = 0,
}: {
  summary: ReturnType<typeof rollupByVendor>;
  extraLookupCost?: number;
  monthlyNumberCost?: number;
  numberCount?: number;
}) {
  const vendorTotal = summary.total + extraLookupCost;
  const items = [
    {
      label: "ElevenLabs",
      note: "voice + LLM",
      key: "elevenlabs" as const,
      value: summary.elevenlabs,
      color: "#D85A30",
    },
    {
      label: "Twilio calls",
      note: "connection & talk time",
      key: "twilio" as const,
      value: summary.twilio,
      color: "#378ADD",
    },
    {
      label: "Twilio lookup",
      note: "number checks",
      key: "lookup" as const,
      value: summary.lookup + extraLookupCost,
      color: "#1D9E75",
    },
    {
      label: "OpenAI",
      note: "summaries & transcription",
      key: "openai" as const,
      value: summary.openai,
      color: "#7F77DD",
    },
  ].sort((a, b) => b.value - a.value);

  return (
    <section
      className="border-border bg-card flex flex-col gap-4 rounded-xl border p-5"
      data-testid="per-vendor-chart"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-foreground text-sm font-semibold">
          Where the money goes
        </h2>
        <p className="text-muted-foreground text-xs tabular-nums">
          {usd(vendorTotal)} across vendors
        </p>
      </div>

      <div className="bg-muted flex h-3.5 w-full overflow-hidden rounded-full">
        {items.map((i) => {
          const pct = vendorTotal > 0 ? (i.value / vendorTotal) * 100 : 0;
          if (pct <= 0) return null;
          return (
            <div
              key={i.key}
              style={{ width: `${pct}%`, background: i.color }}
              title={`${i.label} ${pct.toFixed(0)}%`}
            />
          );
        })}
      </div>

      <ul className="grid grid-cols-1 gap-x-6 gap-y-2.5 sm:grid-cols-2">
        {items.map((i) => {
          const share =
            vendorTotal > 0
              ? `${((i.value / vendorTotal) * 100).toFixed(0)}%`
              : "—";
          return (
            <li
              key={i.key}
              className="flex items-baseline justify-between gap-3 text-sm"
            >
              <span className="text-muted-foreground inline-flex items-center gap-2">
                <span
                  aria-hidden
                  className="inline-block size-2.5 shrink-0 rounded-[3px]"
                  style={{ background: i.color }}
                />
                <span className="text-foreground font-medium">{i.label}</span>
                <span className="text-muted-foreground hidden text-xs sm:inline">
                  {i.note}
                </span>
              </span>
              <span className="text-foreground tabular-nums">
                {usd(i.value)}{" "}
                <span className="text-muted-foreground">· {share}</span>
              </span>
            </li>
          );
        })}
      </ul>

      <div className="border-border/70 flex items-baseline justify-between gap-3 border-t pt-3">
        <span className="text-foreground inline-flex items-center gap-2">
          <Phone className="text-muted-foreground size-3.5 shrink-0" />
          <span className="font-medium">Phone numbers</span>
          <span className="text-muted-foreground hidden text-xs sm:inline">
            {numberCount > 0
              ? `${numberCount} active · flat monthly fee`
              : "no active numbers"}
          </span>
        </span>
        <span className="text-foreground tabular-nums">
          {usd(monthlyNumberCost)}
          <span className="text-muted-foreground">/mo</span>
        </span>
      </div>
      <p className="text-muted-foreground text-[11px]">
        The vendor rows are per-call costs for the selected range. Phone numbers
        are a flat monthly rental, shown on their own line.
      </p>
    </section>
  );
}
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit && npx eslint "src/app/(app)/costs/costs-vendor-breakdown.tsx"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/costs/costs-vendor-breakdown.tsx"
git commit -m "feat(costs): colored segmented vendor breakdown; label EL voice+LLM" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Top campaigns by spend

**Files:**

- Create: `src/app/(app)/costs/costs-top-campaigns.tsx`

- [ ] **Step 1: Write the component**

Create `src/app/(app)/costs/costs-top-campaigns.tsx`:

```tsx
import Link from "next/link";

function usd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `$${value.toFixed(2)}`;
}

export type TopCampaign = {
  campaignId: string;
  name: string;
  spend: number;
  goalMet: number;
  costPerGoalMet: number;
};

/** Compact "top campaigns by spend" list — name, spend bar, spend, and
 *  cost/goal. Sits beside the vendor breakdown. Sourced from rollupByCampaign
 *  on the page. */
export function CostsTopCampaigns({ items }: { items: TopCampaign[] }) {
  if (items.length === 0) {
    return (
      <section className="border-border bg-card rounded-xl border p-5">
        <h2 className="text-foreground text-sm font-semibold">
          Top campaigns by spend
        </h2>
        <p className="text-muted-foreground mt-3 text-sm">
          No campaign spend in this range.
        </p>
      </section>
    );
  }
  const max = Math.max(0.01, ...items.map((i) => i.spend));
  return (
    <section
      data-testid="costs-top-campaigns"
      className="border-border bg-card flex flex-col gap-3 rounded-xl border p-5"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-foreground text-sm font-semibold">
          Top campaigns by spend
        </h2>
        <p className="text-muted-foreground text-xs">spend · cost / goal</p>
      </div>
      <ul className="flex flex-col gap-3">
        {items.map((i) => {
          const pct = (i.spend / max) * 100;
          return (
            <li key={i.campaignId} className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <Link
                  href={`/calls?campaign=${i.campaignId}`}
                  className="text-foreground font-medium underline-offset-4 hover:underline"
                >
                  {i.name}
                </Link>
                <span className="text-muted-foreground tabular-nums">
                  {usd(i.spend)} ·{" "}
                  {i.goalMet === 0 ? "—" : usd(i.costPerGoalMet)}
                </span>
              </div>
              <div className="bg-muted h-1.5 w-full overflow-hidden rounded">
                <div
                  className="h-full"
                  style={{
                    width: `${Math.max(2, pct)}%`,
                    background: "var(--primary)",
                  }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit && npx eslint "src/app/(app)/costs/costs-top-campaigns.tsx"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/costs/costs-top-campaigns.tsx"
git commit -m "feat(costs): top campaigns by spend block" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Recompose the page; remove the old stat strip + insight

**Files:**

- Modify: `src/app/(app)/costs/page.tsx`
- Delete: `src/app/(app)/costs/costs-stat-strip.tsx`, `src/app/(app)/costs/costs-insight.tsx`

- [ ] **Step 1: Check for test selectors on the removed components**

Run: `npx eslint --version >/dev/null; grep -rn "costs-stat-strip\|costs-insight\|CostsStatStrip\|CostsInsight" tests/ src/ || echo "no references"`
If a Playwright spec asserts `data-testid="costs-stat-strip"` or `costs-insight`, update those selectors to `costs-hero` / `costs-kpi-strip` in the spec as part of this task. (The page wiring below is the same regardless.)

- [ ] **Step 2: Swap the imports**

In `src/app/(app)/costs/page.tsx`, replace these import lines:

```tsx
import { CostsInsight } from "./costs-insight";
import { CostsStatStrip } from "./costs-stat-strip";
import { CostsVendorBreakdown } from "./costs-vendor-breakdown";
```

with:

```tsx
import { CostsHero } from "./costs-hero";
import { CostsKpiStrip } from "./costs-kpi-strip";
import { CostsTopCampaigns } from "./costs-top-campaigns";
import { CostsVendorBreakdown } from "./costs-vendor-breakdown";
```

- [ ] **Step 3: Replace the insight-only computations with the top-campaigns list**

In `page.tsx`, replace this block (the insight inputs):

```tsx
// Inputs for the deterministic ROI insight line.
const perCall = totalCalls === 0 ? 0 : summary.total / totalCalls;
const perGoal = totalGoalMet === 0 ? null : summary.total / totalGoalMet;
const campaignRollup = rollupByCampaign(rows);
const efficient = campaignRollup
  .filter((c) => c.goalMet > 0)
  .sort((a, b) => a.costPerGoalMet - b.costPerGoalMet)[0];
const bestCampaign = efficient
  ? {
      name: campaignName.get(efficient.campaignId) ?? "—",
      costPerGoal: efficient.costPerGoalMet,
    }
  : null;
const vendorRanked = [
  { label: "Twilio Calls", value: summary.twilio },
  { label: "ElevenLabs", value: summary.elevenlabs },
  { label: "OpenAI", value: summary.openai },
  { label: "Twilio Lookup", value: summary.lookup },
].sort((a, b) => b.value - a.value);
const topVendor =
  summary.total > 0 && vendorRanked[0].value > 0
    ? {
        label: vendorRanked[0].label,
        share: Math.round((vendorRanked[0].value / summary.total) * 100),
      }
    : null;
const showInsight = totalCalls > 0 && summary.total > 0;
```

with:

```tsx
// Efficiency KPIs (call-only spend) and the top-campaigns-by-spend list.
const perCall = totalCalls === 0 ? 0 : summary.total / totalCalls;
const perGoal = totalGoalMet === 0 ? null : summary.total / totalGoalMet;
const campaignRollup = rollupByCampaign(rows);
const topCampaigns = campaignRollup
  .slice()
  .sort((a, b) => b.spend.total - a.spend.total)
  .slice(0, 5)
  .map((c) => ({
    campaignId: c.campaignId,
    name: campaignName.get(c.campaignId) ?? "—",
    spend: c.spend.total,
    goalMet: c.goalMet,
    costPerGoalMet: c.costPerGoalMet,
  }));
```

- [ ] **Step 4: Swap the stat strip for the hero + KPI strip**

In `page.tsx`, replace the `<CostsStatStrip ... />` element (the whole call):

```tsx
<CostsStatStrip
  spend={summary}
  goalMet={totalGoalMet}
  daily={dailySpend}
  spendDelta={spendDelta}
  periodNumberCost={numberRentalInPeriod}
  periodLookupCost={importLookupCost}
  monthlyNumberCost={monthlyNumberCost}
  mtdSpend={headlineStats.mtdSpend}
  projectedMonthSpend={headlineStats.projectedMonthSpend}
  todaySpend={headlineStats.todaySpend}
/>
```

with:

```tsx
      <CostsHero
        total={periodTotal}
        spendDelta={spendDelta}
        projectedMonthSpend={
          headlineStats.projectedMonthSpend + monthlyNumberCost
        }
        todaySpend={headlineStats.todaySpend}
        daily={dailySpend}
      />

      <CostsKpiStrip
        perGoal={perGoal}
        perCall={perCall}
        goalMet={totalGoalMet}
        totalCalls={totalCalls}
      />
```

- [ ] **Step 5: Swap the insight + breakdown grid for breakdown + top campaigns**

In `page.tsx`, replace this block:

```tsx
<div className={showInsight ? "grid gap-4 lg:grid-cols-2" : "grid gap-4"}>
  {showInsight ? (
    <CostsInsight
      rangeLabel={rangeLabel}
      calls={totalCalls}
      spend={summary.total}
      perCall={perCall}
      perGoal={perGoal}
      bestCampaign={bestCampaign}
      topVendor={topVendor}
    />
  ) : null}
  <CostsVendorBreakdown
    summary={summary}
    extraLookupCost={importLookupCost}
    monthlyNumberCost={monthlyNumberCost}
    numberCount={numberCount}
  />
</div>
```

with:

```tsx
<div className="grid items-start gap-4 lg:grid-cols-2">
  <CostsVendorBreakdown
    summary={summary}
    extraLookupCost={importLookupCost}
    monthlyNumberCost={monthlyNumberCost}
    numberCount={numberCount}
  />
  <CostsTopCampaigns items={topCampaigns} />
</div>
```

- [ ] **Step 6: Delete the now-unused components**

```bash
git rm "src/app/(app)/costs/costs-stat-strip.tsx" "src/app/(app)/costs/costs-insight.tsx"
```

- [ ] **Step 7: Verify**

Run: `npx tsc --noEmit && npx eslint "src/app/(app)/costs/page.tsx" && npm run build`
Expected: all PASS. `rangeLabel` is still used (header). Confirm no "declared but never used" errors for removed vars (`bestCampaign`, `topVendor`, `vendorRanked`, `showInsight` are gone; `rollupByGoalMet`/`rollupByUser`/`rollupByList` still used by the views; `CostsInsight`/`CostsStatStrip` imports removed).

- [ ] **Step 8: Commit**

```bash
git add "src/app/(app)/costs/page.tsx"
git commit -m "feat(costs): recompose page — hero, KPIs, breakdown + top campaigns" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Final verification + PR

- [ ] **Step 1: Full local verification**

Run: `npx tsc --noEmit && npx eslint . && npm run build`
Expected: clean on changed files. (Two pre-existing `tsc` errors in `tests/twilio-inbound.spec.ts` / `tests/twilio-status-webhook.spec.ts` are unrelated and already on main.)

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin feat/costs-redesign
gh pr create --base main --title "Costs page redesign (Phase 2): modern spend dashboard" --body "$(cat <<'EOF'
## What & why
Phase 2 of the Costs overhaul — a modern reskin + smarter hierarchy on top of the now-correct Phase 1 numbers. The feel comes from hierarchy and restraint, and it reuses the app's theme (light/dark) and existing SVG charts (no new dependency).

## Changes
- **Hero**: big total spend + vs-prior delta + month-end projection + today, over a daily-spend area chart (`costs-hero.tsx`).
- **Cost-per-result KPIs**: cost per goal met, cost per call, goals met + conversion rate (`costs-kpi-strip.tsx`).
- **Where the money goes**: colored segmented spend bar + vendor legend with $/%, ElevenLabs labelled "voice + LLM" (restyled `costs-vendor-breakdown.tsx`).
- **Top campaigns by spend** beside the breakdown (`costs-top-campaigns.tsx`).
- Removed the old 4-tile stat strip and the insight line (replaced by the above).

## Scope / safety
- Pure front-end. No data, query, cost-math, migration, or server changes. All views (Campaign/List/Goal/Day/Call/per-user), export, date pills, mock-data banner, and cap-alert safety info are preserved.

## Local verification
`tsc`, `eslint`, `npm run build` clean on changed files.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Then stop for review — do not merge.

---

## Self-review

**Spec coverage:**

- Hero spend + trend → Task 1. ✓
- Cost-per-result KPIs → Task 2. ✓
- Where money goes (colored, EL "voice + LLM") → Task 3. ✓
- Top campaigns → Task 4. ✓
- Recompose + demote insight/caps, reuse data layer, preserve views/export/banner/cap-alert → Task 5 (cap alert + tabs + tables + mock banner left intact). ✓
- Reuse existing charts / no new dependency → hero uses inline SVG (Task 1); per-time view unchanged. ✓
- Pure front-end, no data change → no migration/data tasks. ✓

**Placeholder scan:** none — every component is full code; page edits are exact old→new blocks. ✓

**Type consistency:** `CostsHero` props (total, spendDelta, projectedMonthSpend, todaySpend, daily) match the Task 5 call. `CostsKpiStrip` props (perGoal, perCall, goalMet, totalCalls) match. `CostsTopCampaigns` `TopCampaign` shape (campaignId, name, spend, goalMet, costPerGoalMet) matches the `topCampaigns` map in Task 5. `rollupByCampaign` returns `{ campaignId, calls, goalMet, spend: Breakdown, avgPerCall, costPerGoalMet }` — `c.spend.total` used consistently. ✓
