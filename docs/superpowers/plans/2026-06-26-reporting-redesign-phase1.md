# Reporting redesign Phase 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Reporting filter campaigns-only, hide the Dashboard sentiment columns unless the selected campaign has sentiment data, and turn the App Changelog into a clean read-only list (newest first, no Owner, still addable).

**Architecture:** Simplify the `ReportScope` URL model to `all | campaign`. The dashboard's interest columns become gated by a `showSentiment` prop. The changelog timeline becomes a read-only table with an inline Add form.

**Tech Stack:** Next.js (App Router, RSC), Supabase (PostgREST), shadcn, Playwright (contract tests, live env only).

**Testing note:** No local test runner — Playwright runs against the live env and cannot run here. Each task verifies with `npx tsc --noEmit` + `npx eslint <files>` (and `npm run build` on the page tasks). The Playwright spec is the contract, added but not run locally. Because several tasks change shared signatures, `tsc` may show call-site errors mid-way; it must be clean (except the 3 pre-existing `twilio-*.spec.ts` errors) after the final task.

**Branch:** `feat/reporting-phase1-campaign-filter` (already created; spec committed there). No DB migration.

---

## File structure

- **Modify** `src/lib/agent-analytics/scope.ts` — drop the `agent` variant.
- **Modify** `src/lib/agent-analytics/report-data.ts` — simplify `scopeCallConds`, drop `fetchAgentCampaignIds`, trim `DashboardKpiScope`, drop `owner` from the changelog row.
- **Modify** `src/app/(app)/reporting/scope-picker.tsx` — campaigns-only picker.
- **Modify** `src/app/(app)/reporting/page.tsx` — campaigns-only load, scope parse, `showSentiment` gate.
- **Modify** `src/app/(app)/reporting/dashboard-view.tsx` — `showSentiment` prop gates the Yes/Maybe/No/Warm% columns + the Warm% tile + CSV.
- **Modify** `src/lib/agent-analytics/actions.ts` — `createChangelogEntry` takes fields (no owner).
- **Rewrite** `src/app/(app)/reporting/changelog-table.tsx` — read-only table + inline Add form.
- **Modify** `src/app/share/reporting/[token]/page.tsx` — verify under the simplified scope type.
- **Modify** `tests/reporting-scope.spec.ts` — campaign-only + dashboard-column assertions.

---

## Task 1: Simplify the scope model

**Files:** Modify `src/lib/agent-analytics/scope.ts`

- [ ] **Step 1: Replace the file contents**

```ts
/**
 * What the Reporting hub is scoped to. Carried in the URL as `?scope=`:
 *   all              → every campaign's calls combined (default)
 *   campaign:<uuid>  → one campaign
 */
export type ReportScope =
  | { kind: "all" }
  | { kind: "campaign"; campaignId: string };

/** Parse the raw `?scope=` value. Anything that isn't `campaign:<id>` → all.
 *  Does NOT check the id exists — callers validate against the loaded campaign
 *  list and fall back to all when an id is stale. */
export function parseScopeParam(raw: string | undefined): ReportScope {
  const v = (raw ?? "").trim();
  if (v.startsWith("campaign:")) {
    const id = v.slice("campaign:".length).trim();
    if (id) return { kind: "campaign", campaignId: id };
  }
  return { kind: "all" };
}

/** The `?scope=` string for a scope. */
export function serializeScope(scope: ReportScope): string {
  if (scope.kind === "campaign") return `campaign:${scope.campaignId}`;
  return "all";
}
```

- [ ] **Step 2: Verify** — `npx tsc --noEmit` will now flag the agent-scope call sites (fixed in later tasks). `npx eslint src/lib/agent-analytics/scope.ts` → clean.
- [ ] **Step 3: Commit**

```bash
git add src/lib/agent-analytics/scope.ts
git commit -m "refactor(reporting): scope model is campaign-only (drop agent)"
```

---

## Task 2: Simplify the data layer

**Files:** Modify `src/lib/agent-analytics/report-data.ts`

- [ ] **Step 1: Replace `scopeCallConds` (the agent-rollup helper) with the campaign-only version**

Find `async function scopeCallConds(` and replace the whole function with:

```ts
/** PostgREST `.or()` condition string selecting the calls in a scope, or null
 *  for "all" (no filter). Campaign scope filters by campaign_id. */
function scopeCallConds(scope: ReportScope): string | null {
  if (scope.kind === "campaign") return `campaign_id.eq.${scope.campaignId}`;
  return null;
}
```

Note it is **no longer async** (no campaign lookup). Update its two call sites: in `fetchVoiceRows` and `hasInterestData` change `const conds = await scopeCallConds(supabase, scope);` to `const conds = scopeCallConds(scope);`.

- [ ] **Step 2: Remove `fetchAgentCampaignIds`**

Delete the entire `export async function fetchAgentCampaignIds(...) { ... }` function — nothing references it after Task 4.

- [ ] **Step 3: Trim `DashboardKpiScope`**

Find `export type DashboardKpiScope =` and replace with (drop `agentId`):

```ts
export type DashboardKpiScope = { all?: boolean; campaignIds?: string[] };
```

Then in `fetchDashboardKpis`, delete the line that builds the agent condition:

```ts
if (scope.agentId) conds.push(`agent_id.eq.${scope.agentId}`);
```

(Leave the `campaignIds` condition and the `all`-mode logic untouched.)

- [ ] **Step 4: Drop `owner` from the changelog row**

In the `ChangelogRow` type, remove the `owner: string;` field. In `fetchChangelogRows`, remove `owner` from the `.select(...)` string and remove the `owner: r.owner ?? "",` line from the mapped object. Leave the `change_date desc, created_at desc` ordering as-is (already newest-first).

- [ ] **Step 5: Verify** — `npx eslint src/lib/agent-analytics/report-data.ts` clean; tsc still shows page call-site errors (next tasks).
- [ ] **Step 6: Commit**

```bash
git add src/lib/agent-analytics/report-data.ts
git commit -m "refactor(reporting): campaign-only data scope; drop changelog owner"
```

---

## Task 3: Campaigns-only picker

**Files:** Modify `src/app/(app)/reporting/scope-picker.tsx`

- [ ] **Step 1: Replace the component with the campaigns-only version**

```tsx
"use client";

import { useRouter, useSearchParams } from "next/navigation";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Option = { id: string; name: string };

/** Reporting scope selector. Picks All campaigns or one campaign and navigates
 *  to the same page with the new `?scope=` value (preserving the current
 *  tab/day). `value` is the serialized scope ("all" or "campaign:<id>"). */
export function ScopePicker({
  campaigns,
  value,
}: {
  campaigns: Option[];
  value: string;
}) {
  const router = useRouter();
  const sp = useSearchParams();

  function onChange(next: string) {
    const params = new URLSearchParams(sp.toString());
    params.set("scope", next);
    router.push(`/reporting?${params.toString()}`);
  }

  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id="reporting-scope" className="w-[260px]">
        <SelectValue placeholder="All campaigns (combined)" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All campaigns (combined)</SelectItem>
        {campaigns.length > 0 ? (
          <SelectGroup>
            <SelectLabel>Campaigns</SelectLabel>
            {campaigns.map((c) => (
              <SelectItem key={c.id} value={`campaign:${c.id}`}>
                {c.name}
              </SelectItem>
            ))}
          </SelectGroup>
        ) : null}
      </SelectContent>
    </Select>
  );
}
```

- [ ] **Step 2: Verify** — `npx eslint "src/app/(app)/reporting/scope-picker.tsx"` clean.
- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/reporting/scope-picker.tsx"
git commit -m "feat(reporting): campaigns-only scope picker"
```

---

## Task 4: Wire the admin page (campaign-only + sentiment gate)

**Files:** Modify `src/app/(app)/reporting/page.tsx`

- [ ] **Step 1: Drop the agents query + agent-scope handling**

Find the block that loads agents AND campaigns (a `Promise.all` of `from("agents")` and `from("campaigns")`). Replace it so only campaigns load:

```tsx
const { data: campaignRows } = await supabase
  .from("campaigns")
  .select("id, name")
  .order("name");
const campaigns = (campaignRows ?? []) as { id: string; name: string }[];
```

(Delete the `agents` variable and its query entirely.)

- [ ] **Step 2: Replace the scope validation + kpiScope block**

Find the scope-parse/validation block (it currently has `if (scope.kind === "agent")` and `else if (scope.kind === "campaign")` branches and builds `kpiScope`). Replace the whole block with:

```tsx
// Parse + validate the scope. A stale id (deleted campaign) falls back to All.
let scope = parseScopeParam(str(params.scope));
let scopeLabel = "All campaigns (combined)";
if (scope.kind === "campaign") {
  const found = campaigns.find((c) => c.id === scope.campaignId);
  if (found) scopeLabel = found.name;
  else scope = { kind: "all" };
}
const scopeParam = serializeScope(scope);

// Interest tabs (Voice of Customer, Hot Leads) show when the scope has
// yes/no/maybe data; the dashboard's sentiment columns show only for a single
// campaign that has it (never in the combined view).
const showInterest = await hasInterestData(supabase, scope);
const showSentiment = scope.kind === "campaign" && showInterest;
const visibleTabs = reportingTabsFor(showInterest);
const tab = visibleTabs.some((t) => t.key === str(params.tab))
  ? str(params.tab)
  : "dashboard";

const kpiScope: DashboardKpiScope =
  scope.kind === "all" ? { all: true } : { campaignIds: [scope.campaignId] };
```

- [ ] **Step 3: Update imports**

In the `report-data` import, remove `fetchAgentCampaignIds`, add `type DashboardKpiScope`. In the `scope` import keep `parseScopeParam, serializeScope, type ReportScope`. Remove `agents={agents}` usage (next step).

- [ ] **Step 4: Update the picker + DashboardTab usage**

Change the `<ScopePicker .../>` render to drop the agents prop:

```tsx
<ScopePicker campaigns={campaigns} value={scopeParam} />
```

In the JSX where `<DashboardTab .../>` is rendered, add `showSentiment={showSentiment}`. Then update the `DashboardTab` helper signature + its `<DashboardView>` call to accept and forward it:

```tsx
async function DashboardTab({
  kpiScope,
  selectedDay,
  scopeParam,
  slug,
  showSentiment,
}: {
  kpiScope: DashboardKpiScope;
  selectedDay: string;
  scopeParam: string;
  slug: string;
  showSentiment: boolean;
}) {
  const supabase = await createClient();
  const kpis = await fetchDashboardKpis(supabase, kpiScope);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(selectedDay)
    ? selectedDay
    : yesterdayEt();
  const { data: noteRows } = await supabase
    .from("dashboard_notes")
    .select("day, note");
  const notes: Record<string, string> = {};
  for (const r of noteRows ?? []) notes[r.day] = r.note;
  return (
    <DashboardView
      kpis={kpis}
      day={day}
      historyDays={DASHBOARD_DAYS}
      dayHrefFor={(d) =>
        `/reporting?tab=dashboard&scope=${scopeParam}&day=${d}`
      }
      notes={notes}
      notesEditable
      scopeSlug={slug}
      showSentiment={showSentiment}
    />
  );
}
```

- [ ] **Step 5: Verify** — `npx tsc --noEmit` (DashboardView `showSentiment` prop error remains until Task 5; share page may error until Task 8). `npx eslint "src/app/(app)/reporting/page.tsx"` clean.
- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/reporting/page.tsx"
git commit -m "feat(reporting): campaign-only page wiring + dashboard sentiment gate"
```

---

## Task 5: Gate the dashboard sentiment columns

**Files:** Modify `src/app/(app)/reporting/dashboard-view.tsx`

- [ ] **Step 1: Add the prop**

In the `DashboardView` props object add `showSentiment = false,` to the destructure and `showSentiment?: boolean;` to the type (next to `scopeSlug`).

- [ ] **Step 2: Split the numeric headers**

Replace the `NUM_HEADERS` constant with a base list + a sentiment list:

```tsx
const NUM_HEADERS = [
  "Calls",
  "Conn.",
  ">1m",
  "DMs",
  "CB",
  "CB later",
  "Goals",
  "Not int.",
  "Gatekpr",
  "Hung up",
  "AI err",
  "DNC",
  ...(showSentiment ? ["Yes", "Maybe", "No"] : []),
];
```

- [ ] **Step 3: Gate the Warm % header**

The `Warm %` `<th>` and the sentiment `<td>` cells must only render when `showSentiment`. Wrap the standalone `Warm %` header `<th>...</th>` in `{showSentiment ? (<th ...>Warm %</th>) : null}`. Keep the `rounded-r-md` logic: the last header before Notes should be rounded — compute it by making the **DNC**-or-**Warm%** boundary correct. Simplest: leave the Warm% th as the rounded-right candidate only when shown; when hidden, the last NUM header (DNC) needs `rounded-r-md` if there are no Notes. Apply this rule: if `!showSentiment && !showNotes`, the final numeric column should round its right corner. Achieve it by adding to the numeric-header map a conditional class on the last item:

Replace the numeric-header `<th>` map so the last cell rounds when it's the table's last column:

```tsx
{
  NUM_HEADERS.map((h, i) => {
    const isLast = i === NUM_HEADERS.length - 1 && !showSentiment && !showNotes;
    return (
      <th
        key={h}
        className={`px-3 py-2 text-right font-medium whitespace-nowrap ${isLast ? "rounded-r-md" : ""}`}
      >
        {h}
      </th>
    );
  });
}
{
  showSentiment ? (
    <th
      className={`px-3 py-2 text-right font-medium whitespace-nowrap ${showNotes ? "" : "rounded-r-md"}`}
    >
      Warm %
    </th>
  ) : null;
}
```

- [ ] **Step 4: Gate the sentiment + warm cells in the body**

Wrap the three interest `<td>` cells (`{k.interestYes}`, `{k.interestMaybe}`, `{k.interestNo}`) AND the warm `<td>` (`{warmChip(k.warmPct)}`) so they only render when `showSentiment`:

```tsx
{
  showSentiment ? (
    <>
      <td className="px-3 py-2 text-right tabular-nums">{k.interestYes}</td>
      <td className="px-3 py-2 text-right tabular-nums">{k.interestMaybe}</td>
      <td className="px-3 py-2 text-right tabular-nums">{k.interestNo}</td>
      <td className="px-3 py-2 text-right">{warmChip(k.warmPct)}</td>
    </>
  ) : null;
}
```

- [ ] **Step 5: Fix the empty-state colSpan**

Replace the hardcoded `colSpan={17 + (showNotes ? 1 : 0)}` with a computed count: `Day (1) + NUM_HEADERS.length + (showSentiment ? 1 : 0) + (showNotes ? 1 : 0)`:

```tsx
                    colSpan={
                      1 + NUM_HEADERS.length + (showSentiment ? 1 : 0) + (showNotes ? 1 : 0)
                    }
```

- [ ] **Step 6: Gate the Warm % summary tile**

The summary tiles `<section>` ends with `<KpiTile label="Warm %" value={pct(sel.warmPct)} />`. Wrap it: `{showSentiment ? <KpiTile label="Warm %" value={pct(sel.warmPct)} /> : null}`.

- [ ] **Step 7: Match the CSV to the visible columns**

Replace the `exportRows` map and the CSV `headers` so the four sentiment columns are included only when `showSentiment`:

```tsx
const exportRows = kpis.map((k) => [
  k.day,
  k.callsMade,
  k.connected,
  k.convGt1min,
  k.dms,
  k.callbacks,
  k.callbackLater,
  k.goals,
  k.notInterested,
  k.gatekeeper,
  k.hungUp,
  k.dnc,
  ...(showSentiment
    ? [k.interestYes, k.interestMaybe, k.interestNo, pct(k.warmPct)]
    : []),
]);
```

Wait — the original export also includes `k.aiError` between `hungUp` and `dnc`. Keep it: the base list is `day, callsMade, connected, convGt1min, dms, callbacks, callbackLater, goals, notInterested, gatekeeper, hungUp, aiError, dnc` then the optional sentiment four. Use:

```tsx
const exportRows = kpis.map((k) => [
  k.day,
  k.callsMade,
  k.connected,
  k.convGt1min,
  k.dms,
  k.callbacks,
  k.callbackLater,
  k.goals,
  k.notInterested,
  k.gatekeeper,
  k.hungUp,
  k.aiError,
  k.dnc,
  ...(showSentiment
    ? [k.interestYes, k.interestMaybe, k.interestNo, pct(k.warmPct)]
    : []),
]);
```

And the headers array:

```tsx
            headers={[
              "day",
              "calls_made",
              "connected",
              "conversations_gt1min",
              "dms_reached",
              "callbacks",
              "callback_later",
              "goals_met",
              "not_interested",
              "gatekeeper",
              "hung_up",
              "ai_error",
              "dnc",
              ...(showSentiment
                ? ["interest_yes", "interest_maybe", "interest_no", "warm_pct"]
                : []),
            ]}
```

- [ ] **Step 8: Verify** — `npx tsc --noEmit` (share page may still error until Task 8). `npx eslint "src/app/(app)/reporting/dashboard-view.tsx"` clean. `npm run build` should pass once Task 8 done.
- [ ] **Step 9: Commit**

```bash
git add "src/app/(app)/reporting/dashboard-view.tsx"
git commit -m "feat(reporting): gate dashboard sentiment columns behind showSentiment"
```

---

## Task 6: Changelog create action takes fields (no owner)

**Files:** Modify `src/lib/agent-analytics/actions.ts`

- [ ] **Step 1: Replace `createChangelogEntry`**

```ts
/** Add a changelog entry from the Add form. Owner is intentionally omitted.
 *  change_date defaults to today if blank/invalid; status defaults to "Open". */
export async function createChangelogEntry(input: {
  change_date: string;
  change_type: string;
  status: string;
  summary: string;
  details: string;
  area: string;
  ticket_link: string;
}): Promise<{ error: string | null }> {
  if (!(await isCallerAdmin())) return { error: "Admins only." };
  const t = (s: string) => s.trim() || null;
  const patch: Database["public"]["Tables"]["app_changelog"]["Insert"] = {
    change_type: t(input.change_type),
    status: input.status.trim() || "Open",
    summary: t(input.summary),
    details: t(input.details),
    area: t(input.area),
    ticket_link: t(input.ticket_link),
  };
  if (/^\d{4}-\d{2}-\d{2}$/.test(input.change_date)) {
    patch.change_date = input.change_date;
  }
  const { error } = await adminClient().from("app_changelog").insert(patch);
  if (error) return { error: "Could not add entry." };
  revalidatePath(AGENT_ANALYTICS_PATH);
  return { error: null };
}
```

Leave `updateChangelogField` and `deleteChangelogEntry` in the file (now unused by the UI; a later cleanup removes them — keeping them avoids touching the prompt-log code that shares patterns).

- [ ] **Step 2: Verify** — `npx eslint src/lib/agent-analytics/actions.ts` clean; `npx tsc --noEmit` will flag the old changelog-table call sites until Task 7.
- [ ] **Step 3: Commit**

```bash
git add src/lib/agent-analytics/actions.ts
git commit -m "feat(reporting): changelog create takes fields, drops owner"
```

---

## Task 7: Changelog → read-only table with inline Add form

**Files:** Rewrite `src/app/(app)/reporting/changelog-table.tsx`

- [ ] **Step 1: Replace the whole file**

```tsx
"use client";

import { useState, useTransition } from "react";
import { ExternalLink, Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { createChangelogEntry } from "@/lib/agent-analytics/actions";
import type { ChangelogRow } from "@/lib/agent-analytics/report-data";

import { ExportCsvButton } from "./export-csv-button";

export type { ChangelogRow };

const TYPES = ["Feature", "Fix", "Improvement", "Infra", "Other"];
const STATUSES = ["Open", "In progress", "Done", "Blocked"];

const STATUS_BADGE: Record<string, string> = {
  Open: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  "In progress": "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  Done: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  Blocked: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
};

const EMPTY = {
  change_date: "",
  change_type: "",
  status: "Open",
  summary: "",
  details: "",
  area: "",
  ticket_link: "",
};

/** App Changelog — a manual, read-only log of platform changes (newest first).
 *  Admins can add an entry via the inline form; rows themselves are display-only.
 *  `readOnly` (public share) hides the Add form entirely. */
export function ChangelogTable({
  rows,
  readOnly = false,
}: {
  rows: ChangelogRow[];
  readOnly?: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ ...EMPTY });
  const [isPending, startTransition] = useTransition();

  function field<K extends keyof typeof EMPTY>(k: K, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function submit() {
    startTransition(async () => {
      const res = await createChangelogEntry(form);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success("Entry added");
      setForm({ ...EMPTY });
      setAdding(false);
    });
  }

  const exportRows = rows.map((r) => [
    r.changeDate,
    r.area,
    r.changeType,
    r.summary,
    r.details,
    r.status,
    r.ticketLink,
  ]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        {!readOnly ? (
          <Button
            type="button"
            size="sm"
            onClick={() => setAdding((a) => !a)}
            disabled={isPending}
          >
            <Plus className="size-4" />
            Add entry
          </Button>
        ) : null}
        <span className="text-muted-foreground text-sm">
          {rows.length.toLocaleString()}{" "}
          {rows.length === 1 ? "entry" : "entries"}
        </span>
        <div className="ml-auto">
          <ExportCsvButton
            filename="app-changelog.csv"
            headers={[
              "change_date",
              "area",
              "change_type",
              "summary",
              "details",
              "status",
              "ticket_link",
            ]}
            rows={exportRows}
          />
        </div>
      </div>

      {adding && !readOnly ? (
        <div className="border-border bg-card flex flex-col gap-3 rounded-2xl border p-4 shadow-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="date"
              value={form.change_date}
              onChange={(e) => field("change_date", e.target.value)}
              className="h-8 w-[9rem]"
            />
            <select
              value={form.change_type}
              onChange={(e) => field("change_type", e.target.value)}
              className="border-input bg-background h-8 rounded-md border px-2 text-sm"
            >
              <option value="">Type…</option>
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <select
              value={form.status}
              onChange={(e) => field("status", e.target.value)}
              className="border-input bg-background h-8 rounded-md border px-2 text-sm"
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <Input
            value={form.summary}
            onChange={(e) => field("summary", e.target.value)}
            placeholder="What changed"
            className="h-9 font-medium"
          />
          <Textarea
            value={form.details}
            onChange={(e) => field("details", e.target.value)}
            placeholder="Details…"
            rows={2}
            className="min-h-0 resize-y text-sm"
          />
          <div className="flex flex-wrap gap-2">
            <Input
              value={form.area}
              onChange={(e) => field("area", e.target.value)}
              placeholder="Area"
              className="h-8 w-[10rem]"
            />
            <Input
              value={form.ticket_link}
              onChange={(e) => field("ticket_link", e.target.value)}
              placeholder="Ticket URL"
              className="h-8 min-w-[12rem] flex-1"
            />
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              onClick={submit}
              disabled={isPending}
            >
              Save
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setForm({ ...EMPTY });
                setAdding(false);
              }}
              disabled={isPending}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="border-border text-muted-foreground rounded-2xl border border-dashed px-6 py-12 text-center text-sm">
          No entries yet.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-muted-foreground bg-muted/30 text-left text-[10px] tracking-wide uppercase">
                <th className="rounded-l-md px-3 py-2 font-medium whitespace-nowrap">
                  Date
                </th>
                <th className="px-3 py-2 font-medium whitespace-nowrap">
                  Type
                </th>
                <th className="px-3 py-2 font-medium whitespace-nowrap">
                  Status
                </th>
                <th className="px-3 py-2 font-medium">Summary</th>
                <th className="px-3 py-2 font-medium">Details</th>
                <th className="px-3 py-2 font-medium whitespace-nowrap">
                  Area
                </th>
                <th className="rounded-r-md px-3 py-2 font-medium whitespace-nowrap">
                  Ticket
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className="border-border/60 hover:bg-muted/30 border-b align-top transition-colors"
                >
                  <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                    {r.changeDate || "—"}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {r.changeType || "—"}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span
                      className={
                        "rounded-full px-2 py-0.5 text-[11px] font-medium " +
                        (STATUS_BADGE[r.status] ?? "bg-muted text-foreground")
                      }
                    >
                      {r.status || "Open"}
                    </span>
                  </td>
                  <td className="text-foreground px-3 py-2 font-medium">
                    {r.summary || "—"}
                  </td>
                  <td className="text-muted-foreground px-3 py-2">
                    {r.details || "—"}
                  </td>
                  <td className="text-muted-foreground px-3 py-2 whitespace-nowrap">
                    {r.area || "—"}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {r.ticketLink ? (
                      <a
                        href={r.ticketLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary inline-flex items-center gap-1 hover:underline"
                      >
                        View <ExternalLink className="size-3" />
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify** — `npx tsc --noEmit` clean for this file; `npx eslint "src/app/(app)/reporting/changelog-table.tsx"` clean.
- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/reporting/changelog-table.tsx"
git commit -m "feat(reporting): changelog is a read-only table with inline add"
```

---

## Task 8: Verify the share page under the simplified scope

**Files:** Modify `src/app/share/reporting/[token]/page.tsx` (only if needed)

- [ ] **Step 1: Check usages**

The share page calls `fetchVoiceRows(supabase, { kind: "all" })`, `fetchDashboardKpis(supabase, { all: true })`, `hasInterestData(supabase, { kind: "all" })`, and renders `<DashboardView ... />`. Confirm:

- `{ kind: "all" }` still satisfies the new `ReportScope` (it does).
- `DashboardView` is given `showSentiment={false}` (combined view never shows sentiment). Add `showSentiment={false}` to the share's `<DashboardView>` call (it currently omits it — the default is `false`, so this is optional but explicit is clearer).
- The changelog renders read-only (it passes `readOnly`).

Make the one explicit edit (add `showSentiment={false}` to the share `<DashboardView>`), or leave it (default false). No other change.

- [ ] **Step 2: Verify (full)** — now everything is consistent:
  - `npx tsc --noEmit` → only the 3 pre-existing `twilio-*.spec.ts` errors.
  - `npx eslint "src/app/(app)/reporting" "src/app/share/reporting" src/lib/agent-analytics` → clean.
  - `npm run build` → success.
- [ ] **Step 3: Commit** (if changed)

```bash
git add "src/app/share/reporting/[token]/page.tsx"
git commit -m "chore(reporting): share dashboard explicit showSentiment=false"
```

---

## Task 9: Update the Playwright spec

**Files:** Modify `tests/reporting-scope.spec.ts`

- [ ] **Step 1: Update assertions for campaign-only scope + dashboard columns**

The existing spec seeds two agents and uses `?scope=agent:<id>`. Rewrite it to seed a **campaign with sentiment data** and a **campaign without**, and assert:

- The picker (`#reporting-scope`) exists and has no `agent:` options (only `all` + `campaign:` values).
- Selecting `?scope=campaign:<sentiment campaign>` on the dashboard shows a column header "Yes" (sentiment columns visible).
- Selecting `?scope=campaign:<no-sentiment campaign>` shows no "Yes" header (sentiment columns hidden); the combined view (`?scope=all`) also has no "Yes" header.
- The App Changelog tab renders a table with a "Date" header and no "Owner" header.

Use the same `beforeAll`/`afterAll` seeding shape as the current file (service-role client, `E2E_TEST_EMAIL` owner), but seed campaigns (with `agent_id`, `goal_id`) and calls with `campaign_id` set; one campaign's calls carry `extracted_data: { ai_call_answering_interest: "yes" }`, the other `{}`. Assert with `page.getByRole("columnheader", { name: "Yes" })` visibility and `page.locator("#reporting-scope")`.

- [ ] **Step 2: Verify** — `npx tsc --noEmit` clean for the spec; `npx eslint tests/reporting-scope.spec.ts` clean. (Do not run Playwright.)
- [ ] **Step 3: Commit**

```bash
git add tests/reporting-scope.spec.ts
git commit -m "test(reporting): campaign-only scope + dashboard sentiment columns"
```

---

## Task 10: Final verification + PR

- [ ] **Step 1: Full gates**

```bash
npx tsc --noEmit      # only the 3 pre-existing twilio-*.spec.ts errors
npx eslint "src/app/(app)/reporting" "src/app/share/reporting" src/lib/agent-analytics
npm run build
```

- [ ] **Step 2: Push + PR**

```bash
git push -u origin feat/reporting-phase1-campaign-filter
gh pr create --base main --head feat/reporting-phase1-campaign-filter \
  --title "feat(reporting): Phase 1 — campaign-only filter, dashboard fix, changelog list" \
  --body "Phase 1 of the reporting redesign. Filter is campaigns-only; dashboard Yes/Maybe/No/Warm% columns show only for a campaign that has sentiment data; App Changelog is a read-only table (newest first, no Owner, still addable). No DB migration. Spec: docs/superpowers/specs/2026-06-26-reporting-redesign-phase1-design.md."
```

- [ ] **Step 3: Confirm with Marija before merging** (production-facing; merge auto-deploys).

---

## Self-review notes

- **Spec coverage:** campaign-only filter (T1,T3,T4) ✓; dashboard sentiment gate (T4,T5) ✓; changelog read-only list + Add, no owner, newest-first (T2 owner-drop, T6 action, T7 table) ✓; Voice/Hot Leads tabs unchanged (left as-is) ✓; share all-campaigns (T8) ✓; tests (T9) ✓. No DB migration ✓.
- **Type consistency:** `ReportScope` = all|campaign used in scope.ts, report-data (`scopeCallConds`), page, share. `DashboardKpiScope` = `{all?,campaignIds?}` used by fetchDashboardKpis + page. `DashboardView` gains `showSentiment?: boolean`. `createChangelogEntry(input)` signature matches the changelog-table call. `ChangelogRow` no longer has `owner`; changelog-table never reads it.
- **Placeholder scan:** none — all steps have concrete code.
