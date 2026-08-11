# Cause of Death — Phase 1 Implementation Plan (the funnel, no AI)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Cause of Death" tab to the Reporting hub that shows, for every lead worked in the last 30 days, the single primary reason it hasn't been won — grouped into final losses vs still-in-play, with drill-down to the leads in each cause — using only existing data (no AI, no migration).

**Architecture:** A pure function `computeCauseOfDeath` assigns each distinct lead one cause from its `leads.status` + `decision_maker_reached` + the set of its calls' `outcome` values (furthest stage wins). A server fetcher `fetchCauseOfDeath` gathers the cohort (leads with ≥1 outbound call in-window) — paginating around the 1,000-row cap — and calls the pure function. A server view renders the funnel scoreboard + per-cause drill-down, wired into the existing `?tab=` Reporting switch and the token-gated share page.

**Tech Stack:** Next.js (App Router, Server Components), Supabase/PostgREST via `@supabase/supabase-js`, TypeScript, Vitest (unit), Tailwind. Branch: `feat/cause-of-death` (already created; the design spec lives at `docs/superpowers/specs/2026-08-11-cause-of-death-design.md`).

**Phase 2 (separate plan, not here):** the AI objection engine — a worker over `calls.transcript_json` that fills `objection_category/specific/quote` for the `dm_said_no` bucket. Phase 1 leaves that bucket drilling to the lead list with a "objection detail coming soon" note.

---

## File structure

- **Create** `src/lib/agent-analytics/cause-of-death.ts` — pure types + `computeCauseOfDeath` (cause assignment + aggregation). No DB, no React.
- **Create** `tests/cause-of-death.unit.test.ts` — Vitest unit tests for the pure function.
- **Modify** `src/lib/agent-analytics/report-data.ts` — add the `fetchCauseOfDeath` server fetcher.
- **Create** `src/app/(app)/reporting/cause-of-death-view.tsx` — presentational server component (scoreboard + drill-down).
- **Modify** `src/app/(app)/reporting/reporting-tabs.tsx` — register the tab.
- **Modify** `src/app/(app)/reporting/page.tsx` — add the `CauseOfDeathTab` server component + render branch.
- **Modify** `src/app/share/reporting/[token]/page.tsx` — add the matching render branch so it's shareable.

---

## Task 1: Pure cause-assignment logic

**Files:**

- Create: `src/lib/agent-analytics/cause-of-death.ts`
- Test: `tests/cause-of-death.unit.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/cause-of-death.unit.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import {
  computeCauseOfDeath,
  type LeadForCause,
} from "@/lib/agent-analytics/cause-of-death";

function lead(p: Partial<LeadForCause> & { leadId: string }): LeadForCause {
  return {
    status: "resting",
    decisionMakerReached: false,
    goalMet: false,
    outcomes: [],
    ...p,
  };
}

describe("computeCauseOfDeath — cause assignment (furthest stage wins)", () => {
  test("won: goal_met flag or status", () => {
    const r = computeCauseOfDeath([
      lead({ leadId: "a", goalMet: true, outcomes: ["voicemail", "goal_met"] }),
      lead({ leadId: "b", status: "goal_met" }),
    ]);
    expect(r.counts.won).toBe(2);
    expect(r.groups.won).toBe(2);
  });

  test("won: transferred to a human closer", () => {
    const r = computeCauseOfDeath([
      lead({ leadId: "a", outcomes: ["transferred_to_human"] }),
    ]);
    expect(r.counts.won).toBe(1);
  });

  test("opted out beats everything except won", () => {
    const r = computeCauseOfDeath([
      lead({ leadId: "a", status: "dnc", outcomes: ["not_interested", "dnc"] }),
    ]);
    expect(r.counts.opted_out).toBe(1);
  });

  test("DM said no: a voicemail-then-not_interested lead dies at 'DM said no', not voicemail", () => {
    const r = computeCauseOfDeath([
      lead({
        leadId: "a",
        status: "resting",
        outcomes: ["voicemail", "voicemail", "not_interested"],
      }),
    ]);
    expect(r.counts.dm_said_no).toBe(1);
    expect(r.groups.final).toBe(1);
  });

  test("callback booked and mid-follow-up are 'still in play'", () => {
    const r = computeCauseOfDeath([
      lead({ leadId: "a", status: "callback", outcomes: ["gatekeeper"] }),
      lead({ leadId: "b", status: "ready_to_call", outcomes: ["voicemail"] }),
    ]);
    expect(r.counts.callback_booked).toBe(1);
    expect(r.counts.mid_follow_up).toBe(1);
    expect(r.groups.in_play).toBe(2);
    expect(r.groups.final).toBe(0);
  });

  test("gatekeeper (finished, never reached DM) is a final loss", () => {
    const r = computeCauseOfDeath([
      lead({
        leadId: "a",
        status: "resting",
        decisionMakerReached: false,
        outcomes: ["gatekeeper", "voicemail"],
      }),
    ]);
    expect(r.counts.gatekeeper).toBe(1);
    expect(r.groups.final).toBe(1);
  });

  test("bad number, other (language/ai), never reached", () => {
    const r = computeCauseOfDeath([
      lead({ leadId: "a", status: "resting", outcomes: ["invalid_number"] }),
      lead({ leadId: "b", status: "resting", outcomes: ["language_barrier"] }),
      lead({ leadId: "c", status: "resting", outcomes: ["ai_error"] }),
      lead({
        leadId: "d",
        status: "resting",
        outcomes: ["voicemail", "no_answer", "busy"],
      }),
    ]);
    expect(r.counts.bad_number).toBe(1);
    expect(r.counts.other).toBe(2); // language_barrier + ai_error
    expect(r.counts.never_reached).toBe(1);
  });

  test("totals, groups, and perLead are consistent and deduped", () => {
    const r = computeCauseOfDeath([
      lead({ leadId: "a", goalMet: true }),
      lead({ leadId: "b", outcomes: ["not_interested"] }),
      lead({ leadId: "c", status: "ready_to_call" }),
    ]);
    expect(r.total).toBe(3);
    expect(r.perLead).toHaveLength(3);
    expect(r.groups.won + r.groups.final + r.groups.in_play).toBe(3);
    expect(r.perLead.find((l) => l.leadId === "b")?.cause).toBe("dm_said_no");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/cause-of-death.unit.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/agent-analytics/cause-of-death"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/agent-analytics/cause-of-death.ts`:

```ts
// Pure cause-of-death assignment. No DB, no React — unit-tested in isolation.
//
// Each worked lead gets ONE primary cause = the furthest stage it reached. A
// lead's `status` already encodes "still being worked" (ready_to_call / callback)
// vs "finished" (resting / dnc / goal_met), so no retry-counting is needed.

/** The nine causes (plus `won`, shown for contrast). */
export type CauseKey =
  | "won"
  | "opted_out"
  | "dm_said_no"
  | "callback_booked"
  | "mid_follow_up"
  | "gatekeeper"
  | "bad_number"
  | "other"
  | "never_reached";

export type CauseGroup = "won" | "final" | "in_play";

/** Which group each cause belongs to (drives the scoreboard grouping). */
export const CAUSE_GROUP: Record<CauseKey, CauseGroup> = {
  won: "won",
  opted_out: "final",
  dm_said_no: "final",
  gatekeeper: "final",
  bad_number: "final",
  other: "final",
  never_reached: "final",
  callback_booked: "in_play",
  mid_follow_up: "in_play",
};

/** Human labels for the tab. */
export const CAUSE_LABEL: Record<CauseKey, string> = {
  won: "Won (goal met)",
  opted_out: "Opted out (DNC)",
  dm_said_no: "Decision-maker said no",
  gatekeeper: "Blocked by gatekeeper",
  bad_number: "Bad number",
  other: "Other (language / bot / error)",
  never_reached: "Never reached anyone",
  callback_booked: "Callback booked",
  mid_follow_up: "Mid follow-up",
};

/** Display order within each group. */
export const CAUSE_ORDER: CauseKey[] = [
  "won",
  "dm_said_no",
  "gatekeeper",
  "never_reached",
  "bad_number",
  "opted_out",
  "other",
  "callback_booked",
  "mid_follow_up",
];

/** The minimal per-lead shape the assignment needs. */
export type LeadForCause = {
  leadId: string;
  status: string; // leads.status
  decisionMakerReached: boolean; // leads.decision_maker_reached
  goalMet: boolean; // any goal_met call
  outcomes: string[]; // its outbound calls' non-null outcome values
};

export type CauseResult = {
  total: number;
  counts: Record<CauseKey, number>;
  groups: Record<CauseGroup, number>;
  perLead: { leadId: string; cause: CauseKey }[];
};

const OTHER_OUTCOMES = new Set([
  "language_barrier",
  "ai_receptionist",
  "ai_error",
]);
const NEVER_REACHED_OUTCOMES = new Set([
  "voicemail",
  "no_answer",
  "busy",
  "failed",
]);

/** Assign one cause to a lead (furthest stage wins; first match returns). */
export function assignCause(lead: LeadForCause): CauseKey {
  const has = (o: string) => lead.outcomes.includes(o);

  // 1. Won (or handed to a human closer).
  if (lead.goalMet || lead.status === "goal_met" || has("transferred_to_human"))
    return "won";

  // 2. Hard terminal dispositions override an otherwise in-play status.
  if (lead.status === "dnc" || has("dnc")) return "opted_out";
  if (has("not_interested")) return "dm_said_no";

  // 3. Still being worked (status encodes this).
  if (lead.status === "callback") return "callback_booked";
  if (lead.status === "ready_to_call") return "mid_follow_up";

  // 4. Finished (resting / other terminal) → furthest stage reached.
  if (!lead.decisionMakerReached && has("gatekeeper")) return "gatekeeper";
  if (lead.outcomes.some((o) => OTHER_OUTCOMES.has(o))) return "other";
  if (has("invalid_number")) return "bad_number";
  if (
    lead.outcomes.length > 0 &&
    lead.outcomes.every((o) => NEVER_REACHED_OUTCOMES.has(o))
  )
    return "never_reached";

  return "other";
}

/** Aggregate a cohort of leads into cause counts, group totals, and per-lead. */
export function computeCauseOfDeath(leads: LeadForCause[]): CauseResult {
  const counts: Record<CauseKey, number> = {
    won: 0,
    opted_out: 0,
    dm_said_no: 0,
    callback_booked: 0,
    mid_follow_up: 0,
    gatekeeper: 0,
    bad_number: 0,
    other: 0,
    never_reached: 0,
  };
  const groups: Record<CauseGroup, number> = { won: 0, final: 0, in_play: 0 };
  const perLead: { leadId: string; cause: CauseKey }[] = [];

  for (const lead of leads) {
    const cause = assignCause(lead);
    counts[cause] += 1;
    groups[CAUSE_GROUP[cause]] += 1;
    perLead.push({ leadId: lead.leadId, cause });
  }

  return { total: leads.length, counts, groups, perLead };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/cause-of-death.unit.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent-analytics/cause-of-death.ts tests/cause-of-death.unit.test.ts
git commit -m "feat(reporting): pure cause-of-death assignment + aggregation"
```

---

## Task 2: The `fetchCauseOfDeath` server fetcher

**Files:**

- Modify: `src/lib/agent-analytics/report-data.ts` (add a fetcher near `fetchDashboardKpis`, ~line 155)

Context: the cohort is distinct leads with ≥1 outbound call in the 30-day window. We (a) page every outbound call in-window for the scope — reusing the exact 1,000-row pagination of `fetchDashboardKpis` (report-data.ts:134-153) — collecting each call's `lead_id`, `outcome`, `goal_met`; (b) chunk-fetch those leads' `status` + `decision_maker_reached` (200 ids per `.in()`, using `chunk` from `@/lib/leads/chunk`); (c) build `LeadForCause[]` and hand it to `computeCauseOfDeath`. The scope shape reuses `DashboardKpiScope` ({ all?, campaignIds? }) already exported from this file.

- [ ] **Step 1: Add the fetcher**

Add these imports at the top of `src/lib/agent-analytics/report-data.ts` if not already present:

```ts
import { chunk } from "@/lib/leads/chunk";
import {
  computeCauseOfDeath,
  type CauseResult,
  type LeadForCause,
} from "@/lib/agent-analytics/cause-of-death";
```

Add the fetcher after `fetchDashboardKpis` (after report-data.ts:155):

```ts
/** Cause of death: for every lead with ≥1 outbound call in the dashboard window
 *  (scoped), the single primary reason it isn't won. Pages the calls query
 *  around the 1,000-row cap, then chunk-loads the leads' status/dm flag. */
export async function fetchCauseOfDeath(
  supabase: DB,
  scope: DashboardKpiScope,
): Promise<{ result: CauseResult; companyByLead: Record<string, string> }> {
  const conds: string[] = [];
  if (scope.campaignIds && scope.campaignIds.length > 0) {
    conds.push(`campaign_id.in.(${scope.campaignIds.join(",")})`);
  }
  if (!scope.all && conds.length === 0) {
    return { result: computeCauseOfDeath([]), companyByLead: {} };
  }

  // (a) Page every in-window outbound call → per-lead outcome set + goalMet.
  const PAGE = 1000;
  const since = sinceDaysAgoIso(DASHBOARD_DAYS);
  const byLead = new Map<string, { outcomes: string[]; goalMet: boolean }>();
  for (let offset = 0; ; offset += PAGE) {
    let q = supabase
      .from("calls")
      .select("lead_id, outcome, goal_met")
      .eq("direction", "outbound")
      .gte("started_at", since)
      .order("started_at", { ascending: false })
      .range(offset, offset + PAGE - 1);
    if (!scope.all) q = q.or(conds.join(","));
    const { data } = await q;
    const batch = (data ?? []) as {
      lead_id: string | null;
      outcome: string | null;
      goal_met: boolean | null;
    }[];
    for (const row of batch) {
      if (!row.lead_id) continue;
      const entry = byLead.get(row.lead_id) ?? { outcomes: [], goalMet: false };
      if (row.outcome) entry.outcomes.push(row.outcome);
      if (row.goal_met) entry.goalMet = true;
      byLead.set(row.lead_id, entry);
    }
    if (batch.length < PAGE) break;
    if (offset > 500_000) break; // safety backstop
  }

  const leadIds = [...byLead.keys()];
  if (leadIds.length === 0) {
    return { result: computeCauseOfDeath([]), companyByLead: {} };
  }

  // (b) Chunk-load the leads' status + DM flag + company (200 ids/request).
  const leadMeta = new Map<
    string,
    { status: string; dm: boolean; company: string }
  >();
  for (const ids of chunk(leadIds, 200)) {
    const { data } = await supabase
      .from("leads")
      .select("id, status, decision_maker_reached, company")
      .in("id", ids);
    for (const l of (data ?? []) as {
      id: string;
      status: string | null;
      decision_maker_reached: boolean | null;
      company: string | null;
    }[]) {
      leadMeta.set(l.id, {
        status: l.status ?? "",
        dm: l.decision_maker_reached === true,
        company: l.company ?? "",
      });
    }
  }

  // (c) Build LeadForCause[] and aggregate.
  const leads: LeadForCause[] = [];
  const companyByLead: Record<string, string> = {};
  for (const [leadId, agg] of byLead) {
    const meta = leadMeta.get(leadId);
    if (!meta) continue; // lead deleted since the call — skip
    companyByLead[leadId] = meta.company;
    leads.push({
      leadId,
      status: meta.status,
      decisionMakerReached: meta.dm,
      goalMet: agg.goalMet,
      outcomes: agg.outcomes,
    });
  }

  return { result: computeCauseOfDeath(leads), companyByLead };
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0. (If `DASHBOARD_DAYS` / `sinceDaysAgoIso` / `DB` aren't in scope, confirm their names in report-data.ts and match them — they're used by `fetchDashboardKpis` directly above.)

- [ ] **Step 3: Commit**

```bash
git add src/lib/agent-analytics/report-data.ts
git commit -m "feat(reporting): fetchCauseOfDeath — cohort + per-lead cause"
```

---

## Task 3: The Cause of Death view component

**Files:**

- Create: `src/app/(app)/reporting/cause-of-death-view.tsx`

A presentational **server** component (no client interactivity in Phase 1). Shows the group totals as headline tiles, then a bar per cause (count + % of total), grouped Final losses / Still in play / Won. Drill-down in Phase 1 = a collapsible native `<details>` per cause listing the companies (no client JS needed). Reuse `KpiTile` for the headline and a simple inline bar (mirror `OutcomeBreakdown` styling; keep it self-contained to avoid coupling to the analytics folder's exact props).

- [ ] **Step 1: Create the component**

Create `src/app/(app)/reporting/cause-of-death-view.tsx`:

```tsx
import {
  CAUSE_GROUP,
  CAUSE_LABEL,
  CAUSE_ORDER,
  type CauseKey,
  type CauseResult,
} from "@/lib/agent-analytics/cause-of-death";

const GROUP_TITLE = {
  final: "Final losses",
  in_play: "Still in play",
  won: "Won",
} as const;

const BAR_COLOR: Record<CauseKey, string> = {
  won: "bg-emerald-500",
  callback_booked: "bg-sky-500",
  mid_follow_up: "bg-sky-400",
  dm_said_no: "bg-rose-500",
  gatekeeper: "bg-amber-500",
  never_reached: "bg-zinc-400",
  bad_number: "bg-zinc-500",
  opted_out: "bg-rose-600",
  other: "bg-zinc-400",
};

export function CauseOfDeathView({
  result,
  companyByLead,
}: {
  result: CauseResult;
  companyByLead: Record<string, string>;
}) {
  const { total, counts, groups, perLead } = result;
  if (total === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No leads were worked in this window for the selected scope.
      </p>
    );
  }
  const pct = (n: number) => (total ? Math.round((n / total) * 100) : 0);
  const companiesFor = (cause: CauseKey) =>
    perLead
      .filter((l) => l.cause === cause)
      .map((l) => companyByLead[l.leadId] || "(unknown)");

  const renderGroup = (group: "final" | "in_play" | "won") => {
    const causes = CAUSE_ORDER.filter(
      (c) => CAUSE_GROUP[c] === group && counts[c] > 0,
    );
    if (causes.length === 0) return null;
    return (
      <section key={group} className="space-y-2">
        <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
          {GROUP_TITLE[group]} ({groups[group]})
        </h3>
        <div className="space-y-2">
          {causes.map((cause) => {
            const n = counts[cause];
            const companies = companiesFor(cause);
            return (
              <details key={cause} className="group">
                <summary className="hover:bg-muted/50 flex cursor-pointer items-center gap-3 rounded-lg px-1 py-1">
                  <span className="w-48 shrink-0 text-sm font-medium">
                    {CAUSE_LABEL[cause]}
                    {cause === "dm_said_no" ? (
                      <span className="text-muted-foreground ml-1 text-xs">
                        (objection breakdown coming soon)
                      </span>
                    ) : null}
                  </span>
                  <span className="bg-muted relative h-3 flex-1 overflow-hidden rounded-full">
                    <span
                      className={`absolute inset-y-0 left-0 rounded-full ${BAR_COLOR[cause]}`}
                      style={{ width: `${Math.max(2, pct(n))}%` }}
                    />
                  </span>
                  <span className="w-24 shrink-0 text-right text-sm tabular-nums">
                    {n} · {pct(n)}%
                  </span>
                </summary>
                <ul className="text-muted-foreground mt-1 max-h-56 overflow-auto pl-4 text-xs">
                  {companies.map((c, i) => (
                    <li key={i} className="py-0.5">
                      {c}
                    </li>
                  ))}
                </ul>
              </details>
            );
          })}
        </div>
      </section>
    );
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-3 gap-3">
        <Tile label="Worked leads" value={total} />
        <Tile label="Final losses" value={groups.final} />
        <Tile label="Still in play" value={groups.in_play} />
      </div>
      {renderGroup("final")}
      {renderGroup("in_play")}
      {renderGroup("won")}
    </div>
  );
}

function Tile({ label, value }: { label: string; value: number }) {
  return (
    <div className="border-border bg-card rounded-xl border p-4 shadow-sm">
      <div className="text-muted-foreground text-xs font-medium">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/reporting/cause-of-death-view.tsx"
git commit -m "feat(reporting): cause-of-death scoreboard view"
```

---

## Task 4: Register the tab + wire the render branches

**Files:**

- Modify: `src/app/(app)/reporting/reporting-tabs.tsx:14-21`
- Modify: `src/app/(app)/reporting/page.tsx` (render switch ~147-174; add a `CauseOfDeathTab` server component near `DashboardTab` ~179)
- Modify: `src/app/share/reporting/[token]/page.tsx` (its render switch)

- [ ] **Step 1: Add the tab entry**

In `src/app/(app)/reporting/reporting-tabs.tsx`, add the icon import and the array entry (place it right after `dashboard` so it reads as a headline diagnostic):

```tsx
// add HeartCrack to the existing lucide-react import
import {
  Bot,
  PhoneCall,
  Flame,
  HeartCrack,
  History,
  LayoutDashboard,
  MessageSquare,
} from "lucide-react";
```

```tsx
export const REPORTING_TABS = [
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { key: "cause-of-death", label: "Cause of Death", icon: HeartCrack },
  { key: "voice", label: "Voice of Customer", icon: MessageSquare },
  { key: "hot-leads", label: "Hot Leads", icon: Flame },
  { key: "numbers", label: "Numbers", icon: PhoneCall },
  { key: "changelog", label: "App Changelog", icon: History },
  { key: "prompt-log", label: "Agent Prompt Log", icon: Bot },
] as const;
```

- [ ] **Step 2: Add the tab server component + render branch in the admin page**

In `src/app/(app)/reporting/page.tsx`, add the import:

```tsx
import { fetchCauseOfDeath } from "@/lib/agent-analytics/report-data";
import { CauseOfDeathView } from "./cause-of-death-view";
```

Add a render branch in the switch (after the `dashboard` branch, ~line 155):

```tsx
) : tab === "cause-of-death" ? (
  <CauseOfDeathTab kpiScope={kpiScope} />
```

Add the server component near `DashboardTab` (~line 179):

```tsx
async function CauseOfDeathTab({ kpiScope }: { kpiScope: DashboardKpiScope }) {
  const supabase = await createClient();
  const { result, companyByLead } = await fetchCauseOfDeath(supabase, kpiScope);
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Cause of Death</h2>
        <p className="text-muted-foreground text-sm">
          For every lead worked in the last {DASHBOARD_DAYS} days, the primary
          reason it hasn&apos;t been won. Final losses vs still in play.
        </p>
      </div>
      <CauseOfDeathView result={result} companyByLead={companyByLead} />
    </section>
  );
}
```

(If `DASHBOARD_DAYS` isn't imported in page.tsx, hard-code `30` or import it from the module `DashboardTab` uses — check the existing import list.)

- [ ] **Step 3: Add the matching branch to the share page**

In `src/app/share/reporting/[token]/page.tsx`, mirror the branch (it builds its own service-role `supabase` client — reuse the same `fetchCauseOfDeath(supabase, kpiScope)` call and `CauseOfDeathView`). Add the same `import` and a `case`/branch in that page's render switch, matching how it renders the Dashboard tab. The tab auto-appears in the share nav (no `reportingTabsFor` change needed — it's not Numbers).

- [ ] **Step 4: Verify it renders**

Run: `npx tsc --noEmit` (expect exit 0) and `npx eslint "src/app/(app)/reporting/page.tsx" "src/app/(app)/reporting/reporting-tabs.tsx" "src/app/(app)/reporting/cause-of-death-view.tsx" "src/app/share/reporting/[token]/page.tsx"` (expect exit 0).

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/reporting/reporting-tabs.tsx" "src/app/(app)/reporting/page.tsx" "src/app/share/reporting/[token]/page.tsx"
git commit -m "feat(reporting): wire the Cause of Death tab (admin + share)"
```

---

## Task 5: Live smoke-check + final verification

**Files:** none (verification only).

- [ ] **Step 1: Full local gate**

Run: `npx tsc --noEmit && npx eslint . && npx vitest run tests/cause-of-death.unit.test.ts`
Expected: tsc exit 0, eslint exit 0, tests PASS.

- [ ] **Step 2: Read-only sanity of the fetcher against prod (optional but recommended)**

Because there are no E2E accounts (only `marie@referrizer.com`), confirm the cohort math looks sane by spot-checking counts with a quick read-only query — e.g. compare `computeCauseOfDeath`'s `won` count to the distinct-lead `goal_met` count the Dashboard already shows for the same window. No writes.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feat/cause-of-death
gh pr create --title "feat(reporting): Cause of Death tab (Phase 1 — the funnel)" --body "Phase 1 of the Cause of Death feature (spec: docs/superpowers/specs/2026-08-11-cause-of-death-design.md). New admin Reporting tab: for every lead worked in the last 30 days, the single primary reason it isn't won — final losses vs still in play — with per-cause drill-down to companies. Pure cause-assignment logic is unit-tested (8 tests). No AI, no migration. The 'DM said no' bucket shows a 'objection breakdown coming soon' note — that's Phase 2."
```

---

## Self-review notes (done while writing)

- **Spec coverage:** funnel + per-lead cause (Task 1), cohort + 1,000-row pagination + 200-id chunking (Task 2), scoreboard + drill-down + "objection coming soon" (Task 3), tab + admin + share wiring, per-campaign scope via existing `kpiScope` (Task 4), CSV — **deferred:** Phase 1 uses native `<details>` drill-down and skips a dedicated CSV button to keep it small; add `ExportCsvButton` in Phase 2 alongside the objection columns (noted so it isn't forgotten).
- **Type consistency:** `CauseKey`/`CauseResult`/`LeadForCause` names are identical across Tasks 1→2→3; `fetchCauseOfDeath` returns `{ result, companyByLead }` consumed verbatim in Task 4.
- **No placeholders:** every code step is complete. The two "confirm the existing name" notes (`DASHBOARD_DAYS`, the share-page switch shape) are because those live in files the executor opens; the exact insertion code is given.
