# Call Reviewer — Review UI (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give operators a "Call Review" tab in the Reporting hub that turns the flags the engine produces (Phase 1) into small, severity-grouped **buckets** ("Booking failed then recovered · 15"), each of which deep-links into the existing `/calls` list filtered to those calls — where the operator reads each call in the existing detail modal, confirms/rejects the AI's flags, and marks the call Reviewed.

**Architecture:** Two SQL aggregation views (`review_bucket_counts`, `review_summary`, `security_invoker` so admin RLS applies) do the grouping server-side — never client-side, because the PostgREST 1000-row cap would undercount at 10k calls/day. A `src/lib/review/buckets.ts` data layer reads those views + `review_flag_defs` and shapes them into ordered buckets for a new admin-only Reporting tab. Clicking a bucket navigates to `/calls?review_flag=<key>`; the Calls page resolves that key to a set of `call_id`s (via `call_review_flags`), intersects the calls query on `id`, surfaces each call's evidence quote in a column, and — in the detail modal — shows an admin-only "Call Review" panel with confirm/reject-per-flag and a Mark Reviewed control. Writes go through a service-role, admin-gated server-action module (`src/lib/review/actions.ts`), mirroring `src/lib/agent-analytics/actions.ts`.

**Tech Stack:** Next.js App Router (RSC + server actions), Supabase (RLS `createClient` for admin-gated reads via `security_invoker` views; service-role `createClient<Database>` for writes), TypeScript, Vitest for pure-function unit tests (`tests/call-reviewer.spec.ts`), Tailwind. Playwright is live-env only (no offline gate); verify with `npx tsc --noEmit`, `npx eslint`, `npm run build`.

**Deploy note:** Vercel deploys are blocked by the fair-use limit — all work merges to `main` and is queued, NOT deployed. DB migrations still apply directly (`supabase db push --linked`). Do the migration apply in Task 1; leave deploy to the user.

**Baseline gate expectations:** `npx tsc --noEmit` has 3 pre-existing `twilio-*.spec.ts` errors — those are expected; no NEW errors. `npx eslint` and `npm run build` must be clean.

---

## File Structure

**Create:**

- `supabase/migrations/20260708120000_review_buckets.sql` — the two aggregation views.
- `src/lib/review/buckets.ts` — read layer: `fetchReviewBuckets(client)` → `{ summary, buckets }`; pure `orderBuckets(rows, defs)` helper (unit-tested).
- `src/lib/review/actions.ts` — server actions: `getCallReview`, `markCallReviewed`, `setFlagStatus`. Admin-gated, service-role writes.
- `src/lib/review/calls-filter.ts` — read helpers the Calls page uses: `resolveReviewFlagCallIds`, `fetchCallEvidence`, plus the `NEEDS_REVIEW_BUCKET` constant. (Kept out of `calls-query.ts` so all review logic lives under `src/lib/review/`.)
- `src/app/(app)/reporting/call-review-table.tsx` — client component: the bucket list UI.

**Modify:**

- `src/lib/supabase/database.types.ts` — hand-add the two views under `Views`.
- `src/app/(app)/reporting/reporting-tabs.tsx` — add the `call-review` tab.
- `src/app/(app)/reporting/page.tsx` — render `CallReviewTab`.
- `src/app/(app)/calls/calls-query.ts` — `applyCallFilters` accepts a `reviewCallIds` intersect set.
- `src/app/(app)/calls/page.tsx` — resolve the review flag → call-ids + evidence map; feed the table; auto-show the evidence column; pass `isAdmin` to the modal; include `review_flag` in `hasAnyFilter`.
- `src/app/(app)/calls/columns.tsx` — `DisplayCall.reviewEvidence` + a `review_evidence` column.
- `src/app/(app)/calls/call-detail-modal.tsx` — admin-only "Call Review" panel wired to the actions.
- `tests/call-reviewer.spec.ts` — add `orderBuckets` unit tests.

---

## Task 1: Aggregation views + types

**Files:**

- Create: `supabase/migrations/20260708120000_review_buckets.sql`
- Modify: `src/lib/supabase/database.types.ts` (the `Views` block)

- [ ] **Step 1: Write the migration**

`security_invoker=true` makes the views honor the admin-only RLS already on the base tables, so an admin-gated `createClient()` read sees rows and a member sees none. Counts are computed in SQL to sidestep the PostgREST 1000-row cap.

Create `supabase/migrations/20260708120000_review_buckets.sql`:

```sql
-- Phase 2 (Review UI): server-side aggregation so bucket/summary counts are
-- correct at 10k calls/day (client-side counting would hit PostgREST's 1000-row
-- cap and undercount). security_invoker=true → the admin-only RLS on
-- call_review_flags / call_reviews applies to these views too.

-- Per-flag bucket counts. Rejected flags are excluded (only confirmed +
-- needs_review count toward a bucket). unreviewed = the call has not been
-- marked reviewed yet (call_reviews.reviewed_at is null).
create or replace view public.review_bucket_counts
with (security_invoker = true) as
select
  f.flag_key                                                             as flag_key,
  count(*) filter (where f.status = 'confirmed')                         as confirmed_count,
  count(*) filter (where f.status = 'needs_review')                      as needs_review_count,
  count(*) filter (
    where f.status in ('confirmed', 'needs_review') and r.reviewed_at is null
  )                                                                      as unreviewed_count
from public.call_review_flags f
join public.call_reviews r on r.call_id = f.call_id
group by f.flag_key;

-- One-row roll-up for the tab header. count(distinct call_id) because a call can
-- carry several flags and must count once.
create or replace view public.review_summary
with (security_invoker = true) as
select
  count(distinct f.call_id) filter (
    where f.status in ('confirmed', 'needs_review')
  )                                                                      as flagged_calls,
  count(distinct f.call_id) filter (
    where f.status in ('confirmed', 'needs_review') and r.reviewed_at is null
  )                                                                      as unreviewed_calls,
  count(distinct f.call_id) filter (
    where f.status = 'needs_review'
  )                                                                      as needs_eyes_calls
from public.call_review_flags f
join public.call_reviews r on r.call_id = f.call_id;
```

- [ ] **Step 2: Apply the migration to prod**

Run: `supabase db push --linked`
Expected: applies `20260708120000_review_buckets.sql` with no error. (If the CLI prompts, confirm. Migrations are safe here — additive views only.)

- [ ] **Step 3: Hand-add the views to `database.types.ts`**

Find the `Views:` key inside `public` in `src/lib/supabase/database.types.ts` (it currently holds existing views). Add these two entries alongside the existing ones (do NOT replace the block — insert into it), keeping the surrounding `[_ in never]: never` shape only if `Views` is currently empty. Each view is read-only, so only `Row` is needed:

```ts
review_bucket_counts: {
  Row: {
    flag_key: string | null;
    confirmed_count: number | null;
    needs_review_count: number | null;
    unreviewed_count: number | null;
  }
  Relationships: [];
}
review_summary: {
  Row: {
    flagged_calls: number | null;
    unreviewed_calls: number | null;
    needs_eyes_calls: number | null;
  }
  Relationships: [];
}
```

If `Views: { [_ in never]: never }` is present (empty), replace that with `Views: { <the two entries above> }`.

- [ ] **Step 4: Verify types compile**

Run: `npx tsc --noEmit`
Expected: only the 3 pre-existing `twilio-*.spec.ts` errors; no new errors.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260708120000_review_buckets.sql src/lib/supabase/database.types.ts
git commit -m "feat(review): add bucket/summary aggregation views for Call Review UI"
```

---

## Task 2: Bucket data layer + `orderBuckets` unit test

**Files:**

- Create: `src/lib/review/buckets.ts`
- Test: `tests/call-reviewer.spec.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/call-reviewer.spec.ts`:

```ts
import { orderBuckets, type ReviewBucket } from "@/lib/review/buckets";

describe("orderBuckets", () => {
  const defs = [
    {
      key: "tool_error",
      label: "Tool error mid-call",
      lens: "bug",
      severity: 1,
    },
    {
      key: "rambled_unclear",
      label: "Rambled / unclear",
      lens: "quality",
      severity: 3,
    },
    {
      key: "price_objection",
      label: "Price objection",
      lens: "voc",
      severity: 4,
    },
  ];

  it("keeps only flags with a matching active def and attaches def metadata", () => {
    const rows = [
      {
        flag_key: "price_objection",
        confirmed_count: 2,
        needs_review_count: 0,
        unreviewed_count: 1,
      },
      {
        flag_key: "retired_flag",
        confirmed_count: 9,
        needs_review_count: 0,
        unreviewed_count: 9,
      },
    ];
    const out = orderBuckets(rows, defs);
    expect(out.map((b) => b.key)).toEqual(["price_objection"]);
    expect(out[0].label).toBe("Price objection");
    expect(out[0].lens).toBe("voc");
    expect(out[0].total).toBe(2);
  });

  it("orders by severity (1 first), then by total desc within a severity", () => {
    const rows = [
      {
        flag_key: "rambled_unclear",
        confirmed_count: 5,
        needs_review_count: 0,
        unreviewed_count: 5,
      },
      {
        flag_key: "tool_error",
        confirmed_count: 1,
        needs_review_count: 0,
        unreviewed_count: 1,
      },
      {
        flag_key: "price_objection",
        confirmed_count: 50,
        needs_review_count: 0,
        unreviewed_count: 3,
      },
    ];
    const out = orderBuckets(rows, defs);
    expect(out.map((b) => b.key)).toEqual([
      "tool_error",
      "rambled_unclear",
      "price_objection",
    ]);
  });

  it("drops buckets whose confirmed+needs_review total is zero", () => {
    const rows = [
      {
        flag_key: "tool_error",
        confirmed_count: 0,
        needs_review_count: 0,
        unreviewed_count: 0,
      },
    ];
    expect(orderBuckets(rows, defs)).toEqual([]);
  });

  it("total counts confirmed + needs_review (both are real flags on the call)", () => {
    const rows = [
      {
        flag_key: "tool_error",
        confirmed_count: 3,
        needs_review_count: 2,
        unreviewed_count: 4,
      },
    ];
    const out = orderBuckets(rows, defs);
    expect(out[0].total).toBe(5);
    expect(out[0].needsReview).toBe(2);
    expect(out[0].unreviewed).toBe(4);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/call-reviewer.spec.ts -t orderBuckets`
Expected: FAIL — `orderBuckets` is not exported from `@/lib/review/buckets` (module not found).

- [ ] **Step 3: Implement `src/lib/review/buckets.ts`**

```ts
import "server-only";
import type { createClient as createServerClient } from "@/lib/supabase/server";
import type { ReviewFlagDef } from "./types";

type ServerClient = Awaited<ReturnType<typeof createServerClient>>;

/** A raw per-flag count row from the `review_bucket_counts` view. */
export type BucketCountRow = {
  flag_key: string | null;
  confirmed_count: number | null;
  needs_review_count: number | null;
  unreviewed_count: number | null;
};

/** A bucket shaped for the UI: one flag, its def metadata, and its counts. */
export type ReviewBucket = {
  key: string;
  label: string;
  lens: ReviewFlagDef["lens"];
  severity: number;
  /** confirmed + needs_review — every real flag on a call in this bucket. */
  total: number;
  /** How many of those are the AI-vs-AI disagreements needing a human. */
  needsReview: number;
  /** Calls in this bucket not yet marked reviewed. */
  unreviewed: number;
};

/** Top-of-tab roll-up. */
export type ReviewSummary = {
  flaggedCalls: number;
  unreviewedCalls: number;
  needsEyesCalls: number;
};

type DefLite = Pick<ReviewFlagDef, "key" | "label" | "lens" | "severity">;

/**
 * Shape raw view rows into ordered UI buckets. Pure (no I/O) so it's unit
 * tested. Rules: keep only flags that still have an active def (retired flags
 * drop out), drop empty buckets, order by severity (1 = highest first) then by
 * total desc so the biggest, most severe buckets float to the top.
 */
export function orderBuckets(
  rows: BucketCountRow[],
  defs: DefLite[],
): ReviewBucket[] {
  const defByKey = new Map(defs.map((d) => [d.key, d]));
  const out: ReviewBucket[] = [];
  for (const r of rows) {
    if (!r.flag_key) continue;
    const def = defByKey.get(r.flag_key);
    if (!def) continue;
    const total = (r.confirmed_count ?? 0) + (r.needs_review_count ?? 0);
    if (total <= 0) continue;
    out.push({
      key: def.key,
      label: def.label,
      lens: def.lens,
      severity: def.severity,
      total,
      needsReview: r.needs_review_count ?? 0,
      unreviewed: r.unreviewed_count ?? 0,
    });
  }
  out.sort((a, b) => a.severity - b.severity || b.total - a.total);
  return out;
}

/**
 * Load the Call Review tab's data: the roll-up + the ordered buckets. Reads the
 * two aggregation views + the active rubric through the caller's admin-gated
 * RLS client (the views are security_invoker, so a non-admin sees nothing).
 */
export async function fetchReviewBuckets(
  client: ServerClient,
): Promise<{ summary: ReviewSummary; buckets: ReviewBucket[] }> {
  const [{ data: counts }, { data: summaryRow }, { data: defs }] =
    await Promise.all([
      client
        .from("review_bucket_counts")
        .select(
          "flag_key, confirmed_count, needs_review_count, unreviewed_count",
        ),
      client
        .from("review_summary")
        .select("flagged_calls, unreviewed_calls, needs_eyes_calls")
        .maybeSingle(),
      client
        .from("review_flag_defs")
        .select("key, label, lens, severity")
        .eq("active", true),
    ]);

  const buckets = orderBuckets(
    (counts ?? []) as BucketCountRow[],
    (defs ?? []) as DefLite[],
  );
  const summary: ReviewSummary = {
    flaggedCalls: summaryRow?.flagged_calls ?? 0,
    unreviewedCalls: summaryRow?.unreviewed_calls ?? 0,
    needsEyesCalls: summaryRow?.needs_eyes_calls ?? 0,
  };
  return { summary, buckets };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/call-reviewer.spec.ts -t orderBuckets`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/review/buckets.ts tests/call-reviewer.spec.ts
git commit -m "feat(review): bucket data layer + orderBuckets unit tests"
```

---

## Task 3: "Call Review" Reporting tab

**Files:**

- Modify: `src/app/(app)/reporting/reporting-tabs.tsx:14-18` (the `REPORTING_TABS` array) and `reportingTabsFor`
- Create: `src/app/(app)/reporting/call-review-table.tsx`
- Modify: `src/app/(app)/reporting/page.tsx` (imports + tab render + a new `CallReviewTab` async component)

- [ ] **Step 1: Add the tab definition**

In `src/app/(app)/reporting/reporting-tabs.tsx`, add `ClipboardCheck` to the existing `lucide-react` import, then add the tab as the SECOND entry (right after Dashboard) in `REPORTING_TABS`:

```ts
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { key: "call-review", label: "Call Review", icon: ClipboardCheck },
  { key: "voice", label: "Voice of Customer", icon: MessageSquare },
```

Then confirm `reportingTabsFor(...)` returns `call-review` for every scope. Read the function body: if it filters the list (e.g. removes `voice` for some scopes), make sure `call-review` is NOT filtered out — it's global and always visible. If the function simply returns a scope-conditional subset, add `call-review` to the always-kept keys.

- [ ] **Step 2: Build the bucket list client component**

Create `src/app/(app)/reporting/call-review-table.tsx`:

```tsx
"use client";

import Link from "next/link";
import { AlertTriangle, ArrowRight, Eye } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { ReviewBucket, ReviewSummary } from "@/lib/review/buckets";

/** Sentinel value for the cross-cutting "needs your eyes" filter on /calls. No
 *  real flag_key uses a hyphen, so it can't collide with one. Kept in sync with
 *  NEEDS_REVIEW_BUCKET in src/lib/review/calls-filter.ts. */
const NEEDS_REVIEW_BUCKET = "needs-review";

const LENS_LABEL: Record<ReviewBucket["lens"], string> = {
  bug: "Bugs & failures",
  compliance: "Compliance",
  quality: "Call quality",
  opportunity: "Missed opportunities",
  voc: "Voice of customer",
};

const LENS_ORDER: ReviewBucket["lens"][] = [
  "bug",
  "compliance",
  "quality",
  "opportunity",
  "voc",
];

export function CallReviewTable({
  summary,
  buckets,
}: {
  summary: ReviewSummary;
  buckets: ReviewBucket[];
}) {
  if (buckets.length === 0) {
    return (
      <div className="border-border/70 bg-muted/10 flex flex-col items-center gap-2 rounded-2xl border border-dashed py-14 text-center">
        <Eye className="text-muted-foreground/70 size-7" />
        <p className="text-foreground text-sm font-medium">
          Nothing to review yet
        </p>
        <p className="text-muted-foreground max-w-sm text-sm">
          As the reviewer analyzes human-reached calls, flagged calls group into
          buckets here.
        </p>
      </div>
    );
  }

  // Group the already-severity-ordered buckets by lens for display.
  const byLens = new Map<ReviewBucket["lens"], ReviewBucket[]>();
  for (const b of buckets) {
    const arr = byLens.get(b.lens) ?? [];
    arr.push(b);
    byLens.set(b.lens, arr);
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Summary strip */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <SummaryCard label="Flagged calls" value={summary.flaggedCalls} />
        <SummaryCard label="Unreviewed" value={summary.unreviewedCalls} />
        <SummaryCard
          label="Needs your eyes"
          value={summary.needsEyesCalls}
          tone="warn"
        />
      </div>

      {/* Pinned "needs your eyes" bucket — the AI-vs-AI disagreements. */}
      {summary.needsEyesCalls > 0 ? (
        <Link
          href={`/calls?review_flag=${NEEDS_REVIEW_BUCKET}`}
          className="flex items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 transition-colors hover:bg-amber-100"
        >
          <div className="flex items-center gap-3">
            <AlertTriangle className="size-5 text-amber-600" />
            <div>
              <p className="text-foreground text-sm font-semibold">
                ⚠️ Needs your eyes
              </p>
              <p className="text-muted-foreground text-xs">
                Calls where the two AI passes disagreed — a human should decide.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-foreground text-lg font-bold tabular-nums">
              {summary.needsEyesCalls}
            </span>
            <ArrowRight className="text-muted-foreground size-4" />
          </div>
        </Link>
      ) : null}

      {LENS_ORDER.filter((lens) => byLens.has(lens)).map((lens) => (
        <div key={lens} className="flex flex-col gap-2">
          <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
            {LENS_LABEL[lens]}
          </h3>
          <div className="border-border overflow-hidden rounded-xl border">
            {byLens.get(lens)!.map((b, i) => (
              <Link
                key={b.key}
                href={`/calls?review_flag=${b.key}`}
                className={`hover:bg-muted/40 flex items-center justify-between gap-3 px-4 py-3 transition-colors ${
                  i > 0 ? "border-border border-t" : ""
                }`}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="text-foreground truncate text-sm font-medium">
                    {b.label}
                  </span>
                  {b.needsReview > 0 ? (
                    <Badge
                      variant="outline"
                      className="border-amber-300 text-amber-700"
                    >
                      {b.needsReview} needs eyes
                    </Badge>
                  ) : null}
                  {b.unreviewed > 0 ? (
                    <Badge variant="secondary">{b.unreviewed} unreviewed</Badge>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-foreground text-base font-bold tabular-nums">
                    {b.total}
                  </span>
                  <ArrowRight className="text-muted-foreground size-4" />
                </div>
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function SummaryCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "warn";
}) {
  return (
    <div
      className={`rounded-xl border px-4 py-3 ${
        tone === "warn"
          ? "border-amber-300 bg-amber-50"
          : "border-border bg-card"
      }`}
    >
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="text-foreground mt-0.5 text-2xl font-bold tabular-nums">
        {value.toLocaleString()}
      </p>
    </div>
  );
}
```

- [ ] **Step 3: Wire the tab into `page.tsx`**

In `src/app/(app)/reporting/page.tsx`:

1. Add imports near the other tab imports:

```ts
import { fetchReviewBuckets } from "@/lib/review/buckets";
import { CallReviewTable } from "./call-review-table";
```

2. In the tab-render JSX, add a branch (place it right after the `dashboard` branch, matching the tab's new position):

```tsx
      ) : tab === "call-review" ? (
        <CallReviewTab />
```

3. Add the async component near the other `*Tab` components:

```tsx
async function CallReviewTab() {
  const supabase = await createClient();
  const { summary, buckets } = await fetchReviewBuckets(supabase);
  return <CallReviewTable summary={summary} buckets={buckets} />;
}
```

- [ ] **Step 4: Verify types + lint + build**

Run: `npx tsc --noEmit && npx eslint src/app/(app)/reporting/call-review-table.tsx "src/app/(app)/reporting/page.tsx" src/lib/review/buckets.ts src/app/(app)/reporting/reporting-tabs.tsx`
Expected: no new tsc errors; eslint clean.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/reporting/reporting-tabs.tsx" "src/app/(app)/reporting/call-review-table.tsx" "src/app/(app)/reporting/page.tsx"
git commit -m "feat(review): add Call Review tab with severity-grouped buckets"
```

---

## Task 4: `/calls?review_flag=` filter + evidence column

**Files:**

- Create: `src/lib/review/calls-filter.ts`
- Modify: `src/app/(app)/calls/calls-query.ts` (`applyCallFilters`, `buildCallsQuery`)
- Modify: `src/app/(app)/calls/columns.tsx` (`DisplayCall` + a `review_evidence` column)
- Modify: `src/app/(app)/calls/page.tsx`

- [ ] **Step 1: Add the review-filter read helpers**

Create `src/lib/review/calls-filter.ts`:

```ts
import "server-only";
import type { createClient } from "@/lib/supabase/server";

type ServerClient = Awaited<ReturnType<typeof createClient>>;

/** Sentinel /calls?review_flag value for the cross-cutting "needs your eyes"
 *  bucket (all needs_review flags, any flag_key). No real flag_key uses a
 *  hyphen, so this can't collide. Mirrored in call-review-table.tsx. */
export const NEEDS_REVIEW_BUCKET = "needs-review";

/** One call's flag(s) relevant to the active review_flag view. */
export type CallEvidence = {
  flagKey: string;
  evidenceQuote: string | null;
  status: "confirmed" | "needs_review" | "rejected";
};

/**
 * Resolve a review_flag param value to the set of call_ids it selects, or null
 * when the param is absent/blank (caller then adds no review filter). For a real
 * flag key: calls with that flag in confirmed OR needs_review. For the
 * NEEDS_REVIEW_BUCKET sentinel: calls with ANY needs_review flag. Rejected flags
 * never select a call. Paginates so it isn't capped at 1000 ids.
 */
export async function resolveReviewFlagCallIds(
  supabase: ServerClient,
  reviewFlag: string,
): Promise<string[] | null> {
  const key = reviewFlag.trim();
  if (!key) return null;

  const ids: string[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let q = supabase
      .from("call_review_flags")
      .select("call_id")
      .range(from, from + PAGE - 1);
    if (key === NEEDS_REVIEW_BUCKET) {
      q = q.eq("status", "needs_review");
    } else {
      q = q.eq("flag_key", key).in("status", ["confirmed", "needs_review"]);
    }
    const { data } = await q;
    const rows = data ?? [];
    for (const r of rows) if (r.call_id) ids.push(r.call_id);
    if (rows.length < PAGE) break;
  }
  // De-dupe (a call can appear once per flag; needs-review sentinel is 1/call).
  return [...new Set(ids)];
}

/**
 * For the calls visible on the page, load the flag evidence to surface in the
 * evidence column. Scoped to the same review_flag the list is filtered by, so
 * the quote shown matches the bucket the operator came from.
 */
export async function fetchCallEvidence(
  supabase: ServerClient,
  reviewFlag: string,
  callIds: string[],
): Promise<Map<string, CallEvidence[]>> {
  const key = reviewFlag.trim();
  const map = new Map<string, CallEvidence[]>();
  if (!key || callIds.length === 0) return map;

  let q = supabase
    .from("call_review_flags")
    .select("call_id, flag_key, evidence_quote, status")
    .in("call_id", callIds);
  if (key === NEEDS_REVIEW_BUCKET) {
    q = q.eq("status", "needs_review");
  } else {
    q = q.eq("flag_key", key).in("status", ["confirmed", "needs_review"]);
  }
  const { data } = await q;
  for (const r of data ?? []) {
    if (!r.call_id) continue;
    const arr = map.get(r.call_id) ?? [];
    arr.push({
      flagKey: r.flag_key,
      evidenceQuote: r.evidence_quote,
      status: r.status as CallEvidence["status"],
    });
    map.set(r.call_id, arr);
  }
  return map;
}
```

- [ ] **Step 2: Let `applyCallFilters` intersect on `id`**

In `src/app/(app)/calls/calls-query.ts`, extend `applyCallFilters` with a third optional arg `reviewCallIds` and apply it the same guarded way as `searchLeadIds` but on the `id` column. Change the signature and add the block at the TOP of the function body (right after the `searchLeadIds` block):

```ts
export function applyCallFilters<
  Q extends {
    in(column: string, values: readonly string[]): Q;
    eq(column: string, value: string | boolean): Q;
    gte(column: string, value: string | number): Q;
    lte(column: string, value: string | number): Q;
  },
>(
  query: Q,
  params: SearchParams,
  searchLeadIds?: string[],
  reviewCallIds?: string[],
): Q {
  if (searchLeadIds !== undefined) {
    query = query.in(
      "lead_id",
      searchLeadIds.length > 0
        ? searchLeadIds
        : ["00000000-0000-0000-0000-000000000000"],
    );
  }

  if (reviewCallIds !== undefined) {
    // Same empty-set sentinel guard as searchLeadIds: an empty `.in([])`
    // matches everything in PostgREST, so a no-match must use a dummy uuid.
    query = query.in(
      "id",
      reviewCallIds.length > 0
        ? reviewCallIds
        : ["00000000-0000-0000-0000-000000000000"],
    );
  }
```

Then thread it through `buildCallsQuery`:

```ts
export function buildCallsQuery(
  supabase: SupabaseServerClient,
  params: SearchParams,
  searchLeadIds?: string[],
  reviewCallIds?: string[],
) {
  const query = supabase.from("calls").select(CALLS_SELECT, { count: "exact" });
  return applyCallFilters(query, params, searchLeadIds, reviewCallIds);
}
```

- [ ] **Step 3: Add the evidence field + column in `columns.tsx`**

In `src/app/(app)/calls/columns.tsx`, add to the `DisplayCall` type (after `dialedTarget`):

```ts
/** Review evidence for the active `review_flag` view (empty otherwise). Each
 *  entry is the AI's quote + status for a flag on this call. Surfaced in the
 *  `review_evidence` column so the operator sees WHY a call is in the bucket. */
reviewEvidence: {
  flagKey: string;
  evidenceQuote: string | null;
  status: "confirmed" | "needs_review" | "rejected";
}
[];
```

Then add a column to the `CALL_COLUMNS` array (place it as the last entry before any trailing actions-only column; a self-contained cell so it's null-safe when there's no evidence):

```ts
  {
    key: "review_evidence",
    label: "Why flagged",
    width: "w-[280px]",
    cell: (call: DisplayCall) => {
      if (call.reviewEvidence.length === 0)
        return <span className="text-muted-foreground">—</span>;
      return (
        <div className="flex flex-col gap-1">
          {call.reviewEvidence.map((e, i) => (
            <div key={i} className="flex flex-col gap-0.5">
              {e.status === "needs_review" ? (
                <Badge
                  variant="outline"
                  className="w-fit border-amber-300 text-amber-700"
                >
                  needs eyes
                </Badge>
              ) : null}
              <span className="text-muted-foreground line-clamp-2 text-xs italic">
                {e.evidenceQuote ? `“${e.evidenceQuote}”` : "No quote captured"}
              </span>
            </div>
          ))}
        </div>
      );
    },
  },
```

(`Badge` is already imported at the top of `columns.tsx`.)

- [ ] **Step 4: Wire the page**

In `src/app/(app)/calls/page.tsx`:

1. Add imports:

```ts
import {
  resolveReviewFlagCallIds,
  fetchCallEvidence,
} from "@/lib/review/calls-filter";
```

2. Resolve the review flag BEFORE `buildCallsQuery`. Only for admins (the buckets are admin-only; a member has no RLS access to `call_review_flags` and would just get an empty list). Right after `const leadFilterIds = await resolveLeadFilterIds(...)`:

```ts
const reviewFlag = str(params.review_flag);
const reviewCallIds =
  isAdmin && reviewFlag
    ? await resolveReviewFlagCallIds(supabase, reviewFlag)
    : null;
```

3. Pass it into `buildCallsQuery`:

```ts
const { data, count } = await buildCallsQuery(
  supabase,
  params,
  leadFilterIds ?? undefined,
  reviewCallIds ?? undefined,
)
  .order(sort, { ascending: dir === "asc" })
  .order("id", { ascending: true })
  .range(offset, offset + pageSize - 1);
```

4. After `const rawCalls = data ?? [];` and the existing `callIds` computation, fetch the evidence map:

```ts
const evidenceByCall =
  isAdmin && reviewFlag
    ? await fetchCallEvidence(supabase, reviewFlag, callIds)
    : new Map();
```

5. In the `calls: DisplayCall[] = rawCalls.map((c) => ({ ... }))` block, add:

```ts
    reviewEvidence: evidenceByCall.get(c.id) ?? [],
```

6. Auto-show the evidence column when the review filter is active. After the existing `const columns = CALL_COLUMNS.filter((c) => visibleKeys.has(c.key));` line, replace it with:

```ts
const activeKeys = new Set(visibleKeys);
// When the operator came from a Call Review bucket, force the "Why flagged"
// column on so the evidence is visible without touching the column picker.
if (reviewFlag) activeKeys.add("review_evidence");
const columns = CALL_COLUMNS.filter((c) => activeKeys.has(c.key));
```

(Ensure `review_evidence` is NOT in `DEFAULT_COLUMN_KEYS`, so it stays hidden on the normal Calls view — only appears via the filter.)

7. Add `review_flag` to `hasAnyFilter` (first `Boolean(...)` group):

```ts
      str(params.mode) ||
      str(params.review_flag),
```

8. Pass `isAdmin` to the modal so the review panel renders. Change:

```tsx
<CallDetailModal />
```

to:

```tsx
<CallDetailModal isAdmin={isAdmin} />
```

- [ ] **Step 5: Verify types + lint + build**

Run: `npx tsc --noEmit && npx eslint "src/app/(app)/calls/page.tsx" "src/app/(app)/calls/columns.tsx" "src/app/(app)/calls/calls-query.ts" src/lib/review/calls-filter.ts && npm run build`
Expected: no new tsc errors; eslint clean; build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/lib/review/calls-filter.ts "src/app/(app)/calls/calls-query.ts" "src/app/(app)/calls/columns.tsx" "src/app/(app)/calls/page.tsx"
git commit -m "feat(review): /calls?review_flag filter + Why-flagged evidence column"
```

---

## Task 5: Review server actions (get / mark-reviewed / confirm-reject)

**Files:**

- Create: `src/lib/review/actions.ts`

- [ ] **Step 1: Implement the actions**

Create `src/lib/review/actions.ts` (mirrors `src/lib/agent-analytics/actions.ts`: RLS client to identify the admin caller, service-role client to write; admin gate on every mutation):

```ts
"use server";

import { revalidatePath } from "next/cache";

import { createClient as createAdminClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";

type SupabaseAdmin = ReturnType<typeof createAdminClient<Database>>;

function adminClient(): SupabaseAdmin {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  return createAdminClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** Current signed-in admin's id, or null. Review writes are admin-only. */
async function currentAdminId(): Promise<string | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  return me?.role === "admin" ? user.id : null;
}

/** One flag on a call, for the modal's review panel. */
export type CallReviewFlag = {
  id: string;
  flagKey: string;
  label: string;
  lens: string;
  evidenceQuote: string | null;
  confidence: number | null;
  status: "confirmed" | "needs_review" | "rejected";
};

export type CallReviewDetail = {
  status: string;
  reachedHuman: boolean;
  needsReview: boolean;
  reviewedAt: string | null;
  flags: CallReviewFlag[];
};

/**
 * Load a call's review row + its flags (joined to defs for labels). Admin-only.
 * Returns `{ review: null }` when the call has no review row yet (e.g. an old
 * call from before the reviewer went live) — the modal then shows nothing.
 */
export async function getCallReview(
  callId: string,
): Promise<{ review: CallReviewDetail | null; error: string | null }> {
  if (!(await currentAdminId())) return { review: null, error: "Admins only." };
  const admin = adminClient();

  const { data: review } = await admin
    .from("call_reviews")
    .select("status, reached_human, needs_review, reviewed_at")
    .eq("call_id", callId)
    .maybeSingle();
  if (!review) return { review: null, error: null };

  const { data: flagRows } = await admin
    .from("call_review_flags")
    .select("id, flag_key, evidence_quote, confidence, status")
    .eq("call_id", callId);

  const keys = [...new Set((flagRows ?? []).map((f) => f.flag_key))];
  const defByKey = new Map<string, { label: string; lens: string }>();
  if (keys.length > 0) {
    const { data: defs } = await admin
      .from("review_flag_defs")
      .select("key, label, lens")
      .in("key", keys);
    for (const d of defs ?? [])
      defByKey.set(d.key, { label: d.label, lens: d.lens });
  }

  const flags: CallReviewFlag[] = (flagRows ?? []).map((f) => ({
    id: f.id,
    flagKey: f.flag_key,
    label: defByKey.get(f.flag_key)?.label ?? f.flag_key,
    lens: defByKey.get(f.flag_key)?.lens ?? "",
    evidenceQuote: f.evidence_quote,
    confidence: f.confidence,
    status: f.status as CallReviewFlag["status"],
  }));

  return {
    review: {
      status: review.status,
      reachedHuman: review.reached_human,
      needsReview: review.needs_review,
      reviewedAt: review.reviewed_at,
      flags,
    },
    error: null,
  };
}

/** Mark (or unmark) a call as human-reviewed. Admin-only. Stamps reviewed_by/at
 *  so the bucket "unreviewed" counts drop. */
export async function markCallReviewed(input: {
  callId: string;
  reviewed: boolean;
}): Promise<{ error: string | null }> {
  const adminId = await currentAdminId();
  if (!adminId) return { error: "Admins only." };
  const { error } = await adminClient()
    .from("call_reviews")
    .update({
      reviewed_by: input.reviewed ? adminId : null,
      reviewed_at: input.reviewed ? new Date().toISOString() : null,
    })
    .eq("call_id", input.callId);
  if (error) return { error: "Could not update review state." };
  revalidatePath("/calls");
  revalidatePath("/reporting");
  return { error: null };
}

/** Confirm or reject a single AI flag. Admin-only. Rejecting drops it out of its
 *  bucket (buckets only count confirmed + needs_review). */
export async function setFlagStatus(input: {
  flagId: string;
  status: "confirmed" | "rejected";
}): Promise<{ error: string | null }> {
  if (!(await currentAdminId())) return { error: "Admins only." };
  const { error } = await adminClient()
    .from("call_review_flags")
    .update({ status: input.status })
    .eq("id", input.flagId);
  if (error) return { error: "Could not update the flag." };
  revalidatePath("/calls");
  revalidatePath("/reporting");
  return { error: null };
}
```

- [ ] **Step 2: Verify types + lint**

Run: `npx tsc --noEmit && npx eslint src/lib/review/actions.ts`
Expected: no new tsc errors; eslint clean.

- [ ] **Step 3: Commit**

```bash
git add src/lib/review/actions.ts
git commit -m "feat(review): admin-gated actions for get/mark-reviewed/confirm-reject"
```

---

## Task 6: "Call Review" panel in the call detail modal

**Files:**

- Modify: `src/app/(app)/calls/call-detail-modal.tsx`

- [ ] **Step 1: Add imports + a review-panel subcomponent**

At the top of `src/app/(app)/calls/call-detail-modal.tsx`, add to the imports:

```ts
import {
  getCallReview,
  markCallReviewed,
  setFlagStatus,
  type CallReviewDetail,
} from "@/lib/review/actions";
```

Then add this self-contained component (it does its own data-load, so it only queries when an admin actually opens a call — no cost on the member path):

```tsx
/** Admin-only review panel inside the call modal: the AI's flags with
 *  confirm/reject, plus a Mark-reviewed toggle. Loads its own data keyed off
 *  the open call id. */
function CallReviewPanel({ callId }: { callId: string }) {
  const router = useRouter();
  const [review, setReview] = useState<CallReviewDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getCallReview(callId).then((res) => {
      if (cancelled) return;
      setReview(res.review);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [callId]);

  if (loading || !review) return null; // No review row (old call) → show nothing.

  function refresh() {
    getCallReview(callId).then((res) => setReview(res.review));
    router.refresh();
  }

  function toggleReviewed() {
    startTransition(async () => {
      const res = await markCallReviewed({
        callId,
        reviewed: review.reviewedAt === null,
      });
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success(
        review.reviewedAt === null ? "Marked reviewed" : "Reopened",
      );
      refresh();
    });
  }

  function updateFlag(flagId: string, status: "confirmed" | "rejected") {
    startTransition(async () => {
      const res = await setFlagStatus({ flagId, status });
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success(
        status === "confirmed" ? "Flag confirmed" : "Flag rejected",
      );
      refresh();
    });
  }

  return (
    <div className="border-border flex flex-col gap-3 rounded-xl border p-4">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-foreground text-sm font-semibold">Call review</h4>
        <Button
          size="sm"
          variant={review.reviewedAt ? "outline" : "default"}
          disabled={pending}
          onClick={toggleReviewed}
        >
          {review.reviewedAt ? "Reviewed ✓ — reopen" : "Mark reviewed"}
        </Button>
      </div>

      {review.flags.length === 0 ? (
        <p className="text-muted-foreground text-xs">No flags on this call.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {review.flags.map((f) => (
            <div
              key={f.id}
              className="border-border/70 flex items-start justify-between gap-3 rounded-lg border p-3"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="text-foreground text-sm font-medium">
                    {f.label}
                  </span>
                  {f.status === "needs_review" ? (
                    <Badge
                      variant="outline"
                      className="border-amber-300 text-amber-700"
                    >
                      needs eyes
                    </Badge>
                  ) : f.status === "rejected" ? (
                    <Badge variant="secondary">rejected</Badge>
                  ) : (
                    <Badge variant="outline">confirmed</Badge>
                  )}
                </div>
                {f.evidenceQuote ? (
                  <p className="text-muted-foreground line-clamp-3 text-xs italic">
                    “{f.evidenceQuote}”
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending || f.status === "confirmed"}
                  onClick={() => updateFlag(f.id, "confirmed")}
                >
                  Confirm
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending || f.status === "rejected"}
                  onClick={() => updateFlag(f.id, "rejected")}
                >
                  Reject
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Render the panel inside the modal (admin only)**

`CallDetailModal` already receives `isAdmin`. Inside its JSX, where the call body renders (near the summary/transcript sections, while `call` is non-null), add:

```tsx
{
  isAdmin && call ? <CallReviewPanel callId={call.id} /> : null;
}
```

Place it as its own block in the modal's content column (e.g. just above or below the summary card) so it reads as a distinct section. Do NOT put it where `loading` is true — guard on `call` being loaded as shown.

- [ ] **Step 3: Verify types + lint + build**

Run: `npx tsc --noEmit && npx eslint "src/app/(app)/calls/call-detail-modal.tsx" && npm run build`
Expected: no new tsc errors; eslint clean; build succeeds.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/calls/call-detail-modal.tsx"
git commit -m "feat(review): confirm/reject flags + mark-reviewed in the call modal"
```

---

## Task 7: Full-branch review + final gates

**Files:** none (review + verification only)

- [ ] **Step 1: Run the full gate suite**

Run: `npx tsc --noEmit && npx eslint . && npm run build && npx vitest run tests/call-reviewer.spec.ts`
Expected: only the 3 known `twilio-*.spec.ts` tsc errors; eslint clean; build succeeds; vitest green.

- [ ] **Step 2: Dispatch the code-reviewer**

Use the `superpowers:code-reviewer` agent against the whole branch diff vs `main`, with the spec (`docs/superpowers/specs/2026-07-05-call-reviewer-design.md`, "Review UI" section) and this plan as the contract. Fix anything Critical/Important it finds; note Minor items in the merge message.

- [ ] **Step 3: Manual review checklist**

- [ ] Buckets are admin-only: `/reporting` redirects non-admins; `review_bucket_counts`/`review_summary` are `security_invoker` so RLS blocks members.
- [ ] Empty-set guards: `resolveReviewFlagCallIds` returning `[]` yields the dummy-uuid sentinel (no calls), never "all calls".
- [ ] `review_evidence` is NOT in `DEFAULT_COLUMN_KEYS` (stays hidden on the normal Calls view).
- [ ] Non-admin hitting `/calls?review_flag=x` gets `reviewCallIds = null` (filter simply not applied) — not a broken/empty page.
- [ ] `markCallReviewed` / `setFlagStatus` both re-check admin server-side (never trust the client).

- [ ] **Step 4: Merge to main (queued for deploy)**

```bash
git checkout main
git merge --no-ff feat/call-reviewer-ui -m "Merge feat/call-reviewer-ui: Call Reviewer Phase 2 (Review UI)"
git push
```

Deploy stays blocked (Vercel fair-use) — the user will deploy when cleared. The migration (Task 1) is already applied to prod, so the tab renders empty until the engine cron is live.

---

## Self-Review

**Spec coverage (Review UI section):**

- "Call Review" tab in Reporting hub → Task 3. ✅
- Severity-grouped bucket list + total/unreviewed/needs-eyes counts → Tasks 2 (data) + 3 (UI). ✅
- Pinned "⚠️ Needs your eyes" bucket → Task 3 (summary + pinned link, `NEEDS_REVIEW_BUCKET`). ✅
- Bucket → filtered `/calls?review_flag=<key>` → Task 4. ✅
- Evidence quote surfaced in the list → Task 4 (`review_evidence` column). ✅
- Review call-by-call in the existing modal; Mark Reviewed; confirm/reject flags → Tasks 5 + 6. ✅
- Human-reached scale / no 1000-row undercount → Task 1 (SQL views) + Task 4 (paginated id resolve). ✅

**Placeholder scan:** No TBD/TODO; every code step is complete. ✅

**Type consistency:** `NEEDS_REVIEW_BUCKET = "needs-review"` defined in both `calls-filter.ts` (source of truth) and `call-review-table.tsx` (UI copy, commented as mirrored). `ReviewBucket`/`ReviewSummary` produced in `buckets.ts`, consumed in `call-review-table.tsx`. `reviewEvidence` shape in `columns.tsx` matches `CallEvidence` in `calls-filter.ts`. `CallReviewDetail`/`CallReviewFlag` produced in `actions.ts`, consumed in the modal. Function names stable across tasks (`resolveReviewFlagCallIds`, `fetchCallEvidence`, `fetchReviewBuckets`, `orderBuckets`, `getCallReview`, `markCallReviewed`, `setFlagStatus`). ✅
