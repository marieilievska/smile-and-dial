# Reporting multi-agent filter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin filter the Reporting hub by agent or campaign (defaulting to an all-agents combined view), with the interest-based tabs (Voice of Customer, Hot Leads) appearing only when the selected scope actually has yes/no/maybe data.

**Architecture:** A URL `?scope=` param (`all` | `agent:<id>` | `campaign:<id>`) drives server-rendered data. A small `scope.ts` module holds the type + parse/serialize. The existing `report-data.ts` fetchers become scope-aware (`fetchDashboardKpis` gains an "all" mode; `fetchVoiceRows` takes a scope; new `hasInterestData` decides tab visibility). A new client `ScopePicker` navigates between scopes. The admin page and the public share both consume these; the share is fixed to all-agents with no picker.

**Tech Stack:** Next.js (App Router, RSC), Supabase (PostgREST), shadcn `Select`, Playwright (contract tests, run against live env only).

**Testing note:** This project has **no local unit-test runner**; Playwright specs run against the live environment and cannot be run here. Each task therefore verifies with `npx tsc --noEmit` and `npx eslint <files>` (and `npm run build` on the page tasks). The Playwright spec (Task 8) is the behavioral contract, added but not run locally.

**Branch:** `feat/reporting-multi-agent-filter` (already created; the design spec is committed there).

---

## File structure

- **Create** `src/lib/agent-analytics/scope.ts` — `ReportScope` type + `parseScopeParam` / `serializeScope` (pure).
- **Modify** `src/lib/agent-analytics/report-data.ts` — `fetchDashboardKpis` all-mode; `fetchVoiceRows(scope)`; new `hasInterestData(scope)` and `fetchAgentCampaignIds`.
- **Create** `src/app/(app)/reporting/scope-picker.tsx` — client combobox that navigates `?scope=`.
- **Modify** `src/app/(app)/reporting/reporting-tabs.tsx` — accept a `tabs` subset so interest tabs can be hidden; export a `reportingTabsFor(showInterest)` helper.
- **Modify** `src/app/(app)/reporting/page.tsx` — parse scope, load agents+campaigns, render picker, gate tabs, scope the data calls, preserve `scope` in tab/day links.
- **Modify** `src/app/share/reporting/[token]/page.tsx` — all-agents view; remove the Market-Research lock; no picker.
- **Modify** `src/app/(app)/reporting/{dashboard-view,voice-table,hot-leads-table}.tsx` — accept a `scopeSlug` prop for the CSV filename.
- **Create** `tests/reporting-scope.spec.ts` — contract test.

---

## Task 1: Scope model (pure helpers)

**Files:**

- Create: `src/lib/agent-analytics/scope.ts`

- [ ] **Step 1: Write `scope.ts`**

```ts
/**
 * What the Reporting hub is scoped to. Carried in the URL as `?scope=`:
 *   all              → every agent's calls combined (default)
 *   agent:<uuid>     → one agent (rolls up its campaigns)
 *   campaign:<uuid>  → one campaign
 */
export type ReportScope =
  | { kind: "all" }
  | { kind: "agent"; agentId: string }
  | { kind: "campaign"; campaignId: string };

/** Parse the raw `?scope=` value. Unknown/blank/malformed → all. Note: this
 *  does NOT check the id exists — callers validate against the loaded
 *  agent/campaign lists and fall back to all when an id is stale. */
export function parseScopeParam(raw: string | undefined): ReportScope {
  const v = (raw ?? "").trim();
  if (v.startsWith("agent:")) {
    const id = v.slice("agent:".length).trim();
    if (id) return { kind: "agent", agentId: id };
  }
  if (v.startsWith("campaign:")) {
    const id = v.slice("campaign:".length).trim();
    if (id) return { kind: "campaign", campaignId: id };
  }
  return { kind: "all" };
}

/** The `?scope=` string for a scope. */
export function serializeScope(scope: ReportScope): string {
  if (scope.kind === "agent") return `agent:${scope.agentId}`;
  if (scope.kind === "campaign") return `campaign:${scope.campaignId}`;
  return "all";
}
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit` → no new errors. `npx eslint src/lib/agent-analytics/scope.ts` → clean.

- [ ] **Step 3: Commit**

```bash
git add src/lib/agent-analytics/scope.ts
git commit -m "feat(reporting): add ReportScope type + url parse/serialize"
```

---

## Task 2: Scope-aware data layer

**Files:**

- Modify: `src/lib/agent-analytics/report-data.ts`

- [ ] **Step 1: Import the scope type**

At the top of `report-data.ts`, add to the imports:

```ts
import type { ReportScope } from "./scope";
```

- [ ] **Step 2: Make `fetchDashboardKpis` support an "all" mode**

Replace the whole `fetchDashboardKpis` function (currently `report-data.ts:100-135`) with:

```ts
export async function fetchDashboardKpis(
  supabase: DB,
  scope: { all?: boolean; agentId?: string | null; campaignIds?: string[] },
): Promise<DailyKpi[]> {
  // Count by the agent AND/OR the campaign(s). `calls.agent_id` goes NULL if the
  // agent is deleted, but `calls.campaign_id` is durable — so matching on either
  // keeps the dashboard accurate even after an agent is removed.
  const conds: string[] = [];
  if (scope.agentId) conds.push(`agent_id.eq.${scope.agentId}`);
  if (scope.campaignIds && scope.campaignIds.length > 0) {
    conds.push(`campaign_id.in.(${scope.campaignIds.join(",")})`);
  }
  // No scope and not the all-agents view → nothing to report.
  if (!scope.all && conds.length === 0) return [];

  // Paginate: PostgREST hard-caps every response at 1,000 rows on this project
  // (a bare `.limit(5000)` still returns only 1,000), so a busy window would
  // silently undercount the daily call totals. Page through in 1,000-row batches.
  const PAGE = 1000;
  const since = sinceDaysAgoIso(DASHBOARD_DAYS);
  const rows: AgentCallRow[] = [];
  for (let offset = 0; ; offset += PAGE) {
    let q = supabase
      .from("calls")
      .select("started_at, outcome, duration_seconds, extracted_data")
      .eq("direction", "outbound")
      .gte("started_at", since)
      .order("started_at", { ascending: false })
      .range(offset, offset + PAGE - 1);
    // All-agents mode counts every outbound call; scoped mode narrows by
    // agent/campaign.
    if (!scope.all) q = q.or(conds.join(","));
    const { data } = await q;
    const batch = (data ?? []) as AgentCallRow[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
    if (offset > 500_000) break; // safety backstop
  }
  return computeDailyKpis(rows);
}
```

- [ ] **Step 3: Make `fetchVoiceRows` take a scope**

Replace the `fetchVoiceRows` signature + query (currently `report-data.ts:146-160`, keep the `.map(...)` body below it unchanged). New version:

```ts
export async function fetchVoiceRows(
  supabase: DB,
  scope: ReportScope,
): Promise<VoiceRow[]> {
  let q = supabase
    .from("calls")
    .select(
      "id, started_at, extracted_data, theme, suggested_action, lead:leads(company, list:lists(name))",
    )
    .eq("direction", "outbound")
    .gte("started_at", sinceDaysAgoIso(VOICE_DAYS))
    .not("extracted_data->>ai_call_answering_interest", "is", null)
    .order("started_at", { ascending: false })
    .limit(2000);
  if (scope.kind === "agent") q = q.eq("agent_id", scope.agentId);
  else if (scope.kind === "campaign") q = q.eq("campaign_id", scope.campaignId);
  const { data } = await q;

  return ((data ?? []) as unknown as VoiceRawRow[])
    .map((r): VoiceRow | null => {
      const interest = interestOf({
        started_at: r.started_at,
        outcome: null,
        duration_seconds: null,
        extracted_data: r.extracted_data,
      });
      if (!interest) return null; // belt-and-suspenders vs the DB JSON filter
      const ed =
        r.extracted_data && typeof r.extracted_data === "object"
          ? (r.extracted_data as Record<string, unknown>)
          : {};
      const reason =
        typeof ed.ai_call_answering_reason === "string"
          ? ed.ai_call_answering_reason
          : "";
      const { company, list } = leadCompany(r.lead);
      return {
        id: r.id,
        day: r.started_at ? etDay(r.started_at) : "",
        company,
        list,
        interest,
        reason,
        theme: r.theme ?? "",
        suggestedAction: r.suggested_action ?? "",
      };
    })
    .filter((r): r is VoiceRow => r !== null);
}
```

- [ ] **Step 4: Add `hasInterestData` and `fetchAgentCampaignIds`**

Add these two exported functions right after `fetchVoiceRows`:

```ts
/** True when the scope has at least one call carrying an interest answer
 *  (yes/no/maybe) in the Voice window. Drives whether the interest-based tabs
 *  (Voice of Customer, Hot Leads) render. Cheap: a head-only count, no rows. */
export async function hasInterestData(
  supabase: DB,
  scope: ReportScope,
): Promise<boolean> {
  let q = supabase
    .from("calls")
    .select("id", { count: "exact", head: true })
    .eq("direction", "outbound")
    .gte("started_at", sinceDaysAgoIso(VOICE_DAYS))
    .not("extracted_data->>ai_call_answering_interest", "is", null);
  if (scope.kind === "agent") q = q.eq("agent_id", scope.agentId);
  else if (scope.kind === "campaign") q = q.eq("campaign_id", scope.campaignId);
  const { count } = await q;
  return (count ?? 0) > 0;
}

/** The campaign ids run by an agent. Passed alongside agentId to
 *  fetchDashboardKpis so totals survive the agent row being deleted later
 *  (calls keep campaign_id; only agent_id goes null). */
export async function fetchAgentCampaignIds(
  supabase: DB,
  agentId: string,
): Promise<string[]> {
  const { data } = await supabase
    .from("campaigns")
    .select("id")
    .eq("agent_id", agentId);
  return (data ?? []).map((c) => (c as { id: string }).id);
}
```

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit` → no new errors. `npx eslint src/lib/agent-analytics/report-data.ts` → clean.

Note: this changes `fetchDashboardKpis`/`fetchVoiceRows` call sites — `page.tsx` and the share page will show tsc errors until Tasks 5 & 6. That's expected; run tsc again after those tasks. If you want a green tsc here, do Tasks 5–6 before committing, or accept the transient call-site errors and confirm only `report-data.ts`/`scope.ts` are internally consistent.

- [ ] **Step 6: Commit**

```bash
git add src/lib/agent-analytics/report-data.ts
git commit -m "feat(reporting): scope-aware kpis/voice + hasInterestData helper"
```

---

## Task 3: Scope picker component

**Files:**

- Create: `src/app/(app)/reporting/scope-picker.tsx`

- [ ] **Step 1: Write `scope-picker.tsx`**

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

/** Reporting scope selector. Picks All agents, one agent, or one campaign and
 *  navigates to the same page with the new `?scope=` value (preserving the
 *  current tab/day). `value` is the serialized scope (e.g. "all",
 *  "agent:<id>"). */
export function ScopePicker({
  agents,
  campaigns,
  value,
}: {
  agents: Option[];
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
        <SelectValue placeholder="All agents (combined)" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All agents (combined)</SelectItem>
        {agents.length > 0 ? (
          <SelectGroup>
            <SelectLabel>Agents</SelectLabel>
            {agents.map((a) => (
              <SelectItem key={a.id} value={`agent:${a.id}`}>
                {a.name}
              </SelectItem>
            ))}
          </SelectGroup>
        ) : null}
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

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit` (no new errors in this file) and `npx eslint "src/app/(app)/reporting/scope-picker.tsx"` → clean.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/reporting/scope-picker.tsx"
git commit -m "feat(reporting): scope picker (agent/campaign) navigates ?scope="
```

---

## Task 4: Conditional tabs

**Files:**

- Modify: `src/app/(app)/reporting/reporting-tabs.tsx`

- [ ] **Step 1: Add a helper to pick the visible tab set + let `ReportingTabs` take a subset**

Add this exported helper after the `REPORTING_TABS` definition (after `reporting-tabs.tsx:19`):

```ts
/** The tabs to show for the current scope. The interest-based tabs (Voice of
 *  Customer, Hot Leads) only make sense when the scope has yes/no/maybe data. */
export function reportingTabsFor(
  showInterest: boolean,
): readonly (typeof REPORTING_TABS)[number][] {
  if (showInterest) return REPORTING_TABS;
  return REPORTING_TABS.filter(
    (t) => t.key !== "voice" && t.key !== "hot-leads",
  );
}
```

- [ ] **Step 2: Make `ReportingTabs` render a provided `tabs` list**

Replace the `ReportingTabs` function signature + the `REPORTING_TABS.map` line (currently `reporting-tabs.tsx:25-37`) so it accepts an optional `tabs` prop and maps over it:

```tsx
export function ReportingTabs({
  active,
  hrefFor,
  tabs = REPORTING_TABS,
}: {
  active: string;
  hrefFor: (key: ReportingTabKey) => string;
  tabs?: readonly (typeof REPORTING_TABS)[number][];
}) {
  return (
    <nav
      aria-label="Reporting sections"
      className="border-border bg-card flex flex-wrap items-center gap-1 rounded-xl border p-1 shadow-sm"
    >
      {tabs.map((t) => {
```

(The rest of the `.map` body — the `Link` — is unchanged.)

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit` (no new errors in this file) and `npx eslint "src/app/(app)/reporting/reporting-tabs.tsx"` → clean.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/reporting/reporting-tabs.tsx"
git commit -m "feat(reporting): allow hiding interest tabs via tabs subset"
```

---

## Task 5: Wire the admin Reporting page

**Files:**

- Modify: `src/app/(app)/reporting/page.tsx`

- [ ] **Step 1: Replace the imports block (`page.tsx:1-20`)**

```tsx
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { yesterdayEt } from "@/lib/agent-analytics/stats";
import {
  DASHBOARD_DAYS,
  fetchAgentCampaignIds,
  fetchChangelogRows,
  fetchDashboardKpis,
  fetchHotLeadRows,
  fetchPromptLogRows,
  fetchVoiceRows,
  hasInterestData,
} from "@/lib/agent-analytics/report-data";
import {
  parseScopeParam,
  serializeScope,
  type ReportScope,
} from "@/lib/agent-analytics/scope";

import { ChangelogTable } from "./changelog-table";
import { CopyShareLinkButton } from "./copy-share-link-button";
import { DashboardView } from "./dashboard-view";
import { HotLeadsTable } from "./hot-leads-table";
import { PromptLogTable } from "./prompt-log-table";
import {
  REPORTING_TABS,
  ReportingTabs,
  reportingTabsFor,
} from "./reporting-tabs";
import { ScopePicker } from "./scope-picker";
import { VoiceTable } from "./voice-table";
```

- [ ] **Step 2: Add scope helpers below the `str` helper (after `page.tsx:24`)**

```tsx
/** A short, file-safe label for the current scope, used in CSV filenames. */
function scopeSlug(scope: ReportScope, label: string): string {
  if (scope.kind === "all") return "all-agents";
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || scope.kind
  );
}
```

- [ ] **Step 3: Replace the body from the tab/scope resolution through the end of the returned JSX**

Replace everything from `const tab = ...` (currently `page.tsx:44`) down to the closing `);` of the component's `return` (currently `page.tsx:120`) with:

```tsx
  // Load every agent + campaign for the picker (and to validate the URL scope).
  const [{ data: agentRows }, { data: campaignRows }] = await Promise.all([
    supabase.from("agents").select("id, name").order("name"),
    supabase.from("campaigns").select("id, name").order("name"),
  ]);
  const agents = (agentRows ?? []) as { id: string; name: string }[];
  const campaigns = (campaignRows ?? []) as { id: string; name: string }[];

  // Parse + validate the scope. A stale id (deleted agent/campaign) falls back
  // to All so the page never errors on an old link.
  let scope = parseScopeParam(str(params.scope));
  let scopeLabel = "All agents (combined)";
  if (scope.kind === "agent") {
    const found = agents.find((a) => a.id === scope.agentId);
    if (found) scopeLabel = found.name;
    else scope = { kind: "all" };
  } else if (scope.kind === "campaign") {
    const found = campaigns.find((c) => c.id === scope.campaignId);
    if (found) scopeLabel = found.name;
    else scope = { kind: "all" };
  }
  const scopeParam = serializeScope(scope);

  // The interest tabs (Voice of Customer, Hot Leads) only show when the scope
  // has yes/no/maybe data.
  const showInterest = await hasInterestData(supabase, scope);
  const visibleTabs = reportingTabsFor(showInterest);
  const tab = visibleTabs.some((t) => t.key === str(params.tab))
    ? str(params.tab)
    : "dashboard";

  // Map the scope to the dashboard-kpi args (all mode, or agent+its campaigns,
  // or one campaign).
  const kpiScope =
    scope.kind === "all"
      ? { all: true }
      : scope.kind === "agent"
        ? {
            agentId: scope.agentId,
            campaignIds: await fetchAgentCampaignIds(supabase, scope.agentId),
          }
        : { campaignIds: [scope.campaignId] };

  // Public read-only share token (revocable from settings). When set, admins
  // get a "Copy share link" button; when blank, the link is disabled.
  const { data: shareRow } = await supabase
    .from("app_settings")
    .select("agent_analytics_share_token")
    .eq("id", 1)
    .maybeSingle();
  const shareToken = shareRow?.agent_analytics_share_token ?? "";

  const slug = scopeSlug(scope, scopeLabel);

  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-foreground text-2xl font-bold tracking-tight">
            Reporting
          </h1>
          <p className="text-muted-foreground mt-0.5 text-sm">
            For upper-management reporting — agent performance, call results,
            and app changes. Pick an agent or campaign to scope the view.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ScopePicker agents={agents} campaigns={campaigns} value={scopeParam} />
          {shareToken ? <CopyShareLinkButton token={shareToken} /> : null}
        </div>
      </div>

      <ReportingTabs
        active={tab}
        tabs={visibleTabs}
        hrefFor={(k) => `/reporting?tab=${k}&scope=${scopeParam}`}
      />

      {tab === "dashboard" ? (
        <DashboardTab
          kpiScope={kpiScope}
          selectedDay={str(params.day)}
          scopeParam={scopeParam}
          slug={slug}
        />
      ) : tab === "voice" ? (
        <VoiceTab scope={scope} slug={slug} />
      ) : tab === "hot-leads" ? (
        <HotLeadsTab slug={slug} />
      ) : tab === "changelog" ? (
        <ChangelogTab />
      ) : tab === "prompt-log" ? (
        <PromptLogTab />
      ) : null}
    </div>
  );
}
```

- [ ] **Step 4: Replace the `DashboardTab` and `VoiceTab` and `HotLeadsTab` helpers (currently `page.tsx:123-163`)**

```tsx
async function DashboardTab({
  kpiScope,
  selectedDay,
  scopeParam,
  slug,
}: {
  kpiScope: { all?: boolean; agentId?: string | null; campaignIds?: string[] };
  selectedDay: string;
  scopeParam: string;
  slug: string;
}) {
  const supabase = await createClient();
  const kpis = await fetchDashboardKpis(supabase, kpiScope);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(selectedDay)
    ? selectedDay
    : yesterdayEt();
  // Per-day operator notes (admin-only; not passed to the public share).
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
    />
  );
}

async function VoiceTab({ scope, slug }: { scope: ReportScope; slug: string }) {
  const supabase = await createClient();
  return (
    <VoiceTable rows={await fetchVoiceRows(supabase, scope)} scopeSlug={slug} />
  );
}

async function HotLeadsTab({ slug }: { slug: string }) {
  const supabase = await createClient();
  return (
    <HotLeadsTable rows={await fetchHotLeadRows(supabase)} scopeSlug={slug} />
  );
}
```

(The `ChangelogTab` and `PromptLogTab` helpers below are unchanged. `REPORTING_TABS` is still imported because `reportingTabsFor` returns its element type; if eslint flags it as unused, remove `REPORTING_TABS` from the import.)

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit` (expects errors only in `dashboard-view.tsx` / `voice-table.tsx` / `hot-leads-table.tsx` about the new `scopeSlug` prop until Task 7 — and the share page until Task 6). `npx eslint "src/app/(app)/reporting/page.tsx"` → clean.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/reporting/page.tsx"
git commit -m "feat(reporting): scope picker + scoped tabs/data on the admin page"
```

---

## Task 6: Public share page → all-agents view

**Files:**

- Modify: `src/app/share/reporting/[token]/page.tsx`

- [ ] **Step 1: Update the imports (`[token]/page.tsx:9-22`)**

Add `reportingTabsFor` and `hasInterestData`:

```tsx
import {
  REPORTING_TABS,
  ReportingTabs,
  reportingTabsFor,
} from "@/app/(app)/reporting/reporting-tabs";
import { VoiceTable } from "@/app/(app)/reporting/voice-table";
import {
  DASHBOARD_DAYS,
  fetchChangelogRows,
  fetchDashboardKpis,
  fetchHotLeadRows,
  fetchPromptLogRows,
  fetchVoiceRows,
  hasInterestData,
} from "@/lib/agent-analytics/report-data";
```

- [ ] **Step 2: Update the page metadata title (`[token]/page.tsx:30-33`)**

```tsx
export const metadata = {
  title: "Reporting",
  robots: { index: false, follow: false },
};
```

- [ ] **Step 3: Replace the body from the tab resolution through the end of the JSX (`[token]/page.tsx:67-166`)**

```tsx
  // The share is a fixed all-agents combined view (no picker).
  const showInterest = await hasInterestData(supabase, { kind: "all" });
  const visibleTabs = reportingTabsFor(showInterest);
  const tab = visibleTabs.some((t) => t.key === str(sp.tab))
    ? str(sp.tab)
    : "dashboard";

  // Per-day comments on the dashboard: read-only to anyone with the link, and
  // editable when a logged-in admin is viewing the preview (the
  // upsertDashboardNote action re-checks admin, so this is safe).
  let dashNotes: Record<string, string> | undefined;
  let viewerIsAdmin = false;
  if (tab === "dashboard") {
    const { data: noteRows } = await supabase
      .from("dashboard_notes")
      .select("day, note");
    dashNotes = {};
    for (const r of noteRows ?? []) dashNotes[r.day] = r.note;
    try {
      const userClient = await createClient();
      const {
        data: { user },
      } = await userClient.auth.getUser();
      if (user) {
        const { data: me } = await userClient
          .from("profiles")
          .select("role")
          .eq("id", user.id)
          .single();
        viewerIsAdmin = me?.role === "admin";
      }
    } catch {
      // Anonymous viewer — notes stay read-only.
    }
  }

  return (
    <main className="bg-background text-foreground min-h-screen">
      <div className="mx-auto flex max-w-6xl flex-col gap-5 p-6">
        <div>
          <h1 className="text-foreground text-2xl font-bold tracking-tight">
            Reporting
          </h1>
          <p className="text-muted-foreground mt-0.5 text-sm">
            Read-only shared view · all agents · updates live.
          </p>
        </div>

        <ReportingTabs
          active={tab}
          tabs={visibleTabs}
          hrefFor={(k) => `/share/reporting/${token}?tab=${k}`}
        />

        {tab === "dashboard" ? (
          <DashboardView
            kpis={await fetchDashboardKpis(supabase, { all: true })}
            day={yesterdayEt()}
            historyDays={DASHBOARD_DAYS}
            notes={dashNotes}
            notesEditable={viewerIsAdmin}
            scopeSlug="all-agents"
          />
        ) : tab === "voice" ? (
          <VoiceTable
            rows={await fetchVoiceRows(supabase, { kind: "all" })}
            readOnly
            scopeSlug="all-agents"
          />
        ) : tab === "hot-leads" ? (
          <HotLeadsTable
            rows={await fetchHotLeadRows(supabase)}
            readOnly
            scopeSlug="all-agents"
          />
        ) : tab === "changelog" ? (
          <ChangelogTable rows={await fetchChangelogRows(supabase)} readOnly />
        ) : tab === "prompt-log" ? (
          <PromptLogTable rows={await fetchPromptLogRows(supabase)} readOnly />
        ) : null}
      </div>
    </main>
  );
}
```

Note: this removes the `agent`/`campaignIds` by-name lookups entirely. `REPORTING_TABS` stays imported (element type for `reportingTabsFor`); drop it from the import if eslint flags it unused.

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit` (still expects only the `scopeSlug`-prop errors in the three table components until Task 7). `npx eslint "src/app/share/reporting/[token]/page.tsx"` → clean.

- [ ] **Step 5: Commit**

```bash
git add "src/app/share/reporting/[token]/page.tsx"
git commit -m "feat(reporting): share page shows all-agents view, drops MR lock"
```

---

## Task 7: Scope-aware CSV filenames

**Files:**

- Modify: `src/app/(app)/reporting/dashboard-view.tsx` (filename at `:250`)
- Modify: `src/app/(app)/reporting/voice-table.tsx` (filename at `:210`)
- Modify: `src/app/(app)/reporting/hot-leads-table.tsx` (filename at `:221`)

- [ ] **Step 1: `dashboard-view.tsx` — add the prop and use it**

In the `DashboardView` props type, add `scopeSlug?: string;`. Destructure `scopeSlug = "all-agents"` with the other props. Then change the export button filename (`:250`):

```tsx
            filename={`${scopeSlug}-kpis.csv`}
```

- [ ] **Step 2: `voice-table.tsx` — add the prop and use it**

In `VoiceTable` props, add `scopeSlug?: string;`; destructure `scopeSlug = "all-agents"`. Change `:210`:

```tsx
            filename={`${scopeSlug}-voice-of-customer.csv`}
```

- [ ] **Step 3: `hot-leads-table.tsx` — add the prop and use it**

In `HotLeadsTable` props, add `scopeSlug?: string;`; destructure `scopeSlug = "all-agents"`. Change `:221`:

```tsx
            filename={`${scopeSlug}-hot-leads.csv`}
```

- [ ] **Step 4: Verify (full)**

Run all three gates — by now every call site is consistent:

- `npx tsc --noEmit` → no errors except the 3 known pre-existing test-file errors (`twilio-inbound.spec.ts`, `twilio-status-webhook.spec.ts`).
- `npx eslint "src/app/(app)/reporting/dashboard-view.tsx" "src/app/(app)/reporting/voice-table.tsx" "src/app/(app)/reporting/hot-leads-table.tsx"` → clean.
- `npm run build` → succeeds.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/reporting/dashboard-view.tsx" "src/app/(app)/reporting/voice-table.tsx" "src/app/(app)/reporting/hot-leads-table.tsx"
git commit -m "feat(reporting): scope-aware CSV export filenames"
```

---

## Task 8: Playwright contract spec

**Files:**

- Create: `tests/reporting-scope.spec.ts`

This runs against the live env (cannot run locally). It seeds two agents — one with an interest call, one without — plus a campaign and calls, then drives the admin page.

- [ ] **Step 1: Write the spec**

```ts
import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.describe.configure({ mode: "serial" });

/**
 * Reporting scope filter:
 *  - The scope picker is present; default view is All agents.
 *  - An agent WITH interest data shows the Voice of Customer + Hot Leads tabs.
 *  - An agent WITHOUT interest data hides those tabs (Dashboard only).
 */
test.describe("Reporting scope filter", () => {
  const stamp = Date.now();
  let admin: SupabaseClient;
  let ownerId: string;
  let interestAgentId: string;
  let plainAgentId: string;
  let goalId: string;
  let leadId: string;
  const callIds: string[] = [];

  test.beforeAll(async () => {
    admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const { data: owner } = await admin
      .from("profiles")
      .select("id")
      .eq("email", process.env.E2E_TEST_EMAIL ?? "")
      .single();
    ownerId = owner!.id;

    const mk = async (name: string) => {
      const { data } = await admin
        .from("agents")
        .insert({
          owner_id: ownerId,
          name,
          prompt_personality: "x",
          prompt_environment: "x",
          prompt_tone: "x",
          prompt_goal: "x",
          prompt_guardrails: "x",
        })
        .select("id")
        .single();
      return data!.id as string;
    };
    interestAgentId = await mk(`E2E Scope Interest ${stamp}`);
    plainAgentId = await mk(`E2E Scope Plain ${stamp}`);

    const { data: goal } = await admin
      .from("goals")
      .insert({ owner_id: ownerId, name: `E2E Scope Goal ${stamp}` })
      .select("id")
      .single();
    goalId = goal!.id;

    const { data: lead } = await admin
      .from("leads")
      .insert({
        owner_id: ownerId,
        company: `E2E Scope Co ${stamp}`,
        business_phone: `+1555${String(stamp).slice(-7)}`,
        status: "ready_to_call",
      })
      .select("id")
      .single();
    leadId = lead!.id;

    const insertCall = async (
      agentId: string,
      extracted: Record<string, unknown> | null,
    ) => {
      const { data } = await admin
        .from("calls")
        .insert({
          lead_id: leadId,
          agent_id: agentId,
          goal_id: goalId,
          direction: "outbound",
          status: "completed",
          outcome: "completed",
          duration_seconds: 80,
          started_at: new Date().toISOString(),
          extracted_data: extracted,
        })
        .select("id")
        .single();
      callIds.push(data!.id);
    };
    await insertCall(interestAgentId, { ai_call_answering_interest: "yes" });
    await insertCall(plainAgentId, { some_other_field: "value" });
  });

  test.afterAll(async () => {
    for (const id of callIds) await admin.from("calls").delete().eq("id", id);
    await admin
      .from("leads")
      .delete()
      .eq("id", leadId ?? "");
    await admin
      .from("agents")
      .delete()
      .eq("id", interestAgentId ?? "");
    await admin
      .from("agents")
      .delete()
      .eq("id", plainAgentId ?? "");
    await admin
      .from("goals")
      .delete()
      .eq("id", goalId ?? "");
  });

  test("default view shows the picker and the interest tabs", async ({
    page,
  }) => {
    await page.goto("/reporting");
    await expect(page.locator("#reporting-scope")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Voice of Customer" }),
    ).toBeVisible();
  });

  test("an agent without interest data hides the interest tabs", async ({
    page,
  }) => {
    await page.goto(`/reporting?scope=agent:${plainAgentId}`);
    await expect(page.locator("#reporting-scope")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Voice of Customer" }),
    ).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Hot Leads" })).toHaveCount(0);
    // Dashboard is still there.
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible();
  });

  test("an agent with interest data shows the interest tabs", async ({
    page,
  }) => {
    await page.goto(`/reporting?scope=agent:${interestAgentId}`);
    await expect(
      page.getByRole("link", { name: "Voice of Customer" }),
    ).toBeVisible();
  });
});
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit` → no new errors from this file. `npx eslint tests/reporting-scope.spec.ts` → clean. (Do not run Playwright locally — it targets the live env.)

- [ ] **Step 3: Commit**

```bash
git add tests/reporting-scope.spec.ts
git commit -m "test(reporting): scope filter shows/hides interest tabs"
```

---

## Task 9: Final verification + PR

- [ ] **Step 1: Full gates**

```bash
npx tsc --noEmit      # only the 3 pre-existing test-file errors remain
npx eslint "src/app/(app)/reporting" "src/app/share/reporting" src/lib/agent-analytics
npm run build         # succeeds
```

- [ ] **Step 2: Push + open PR**

```bash
git push -u origin feat/reporting-multi-agent-filter
gh pr create --base main --head feat/reporting-multi-agent-filter \
  --title "feat(reporting): filter by agent / campaign" \
  --body "Adds a scope picker (agent or campaign) to the Reporting hub, defaulting to an all-agents combined view. Dashboard re-computes per scope; Voice of Customer + Hot Leads appear only when the scope has yes/no/maybe data. Changelog + Prompt Log unchanged. Public share now shows the all-agents view. Spec: docs/superpowers/specs/2026-06-26-reporting-multi-agent-filter-design.md."
```

- [ ] **Step 3: Confirm with Marija before merging** (production-facing; merge auto-deploys on Vercel). No DB migration in this plan.

---

## Self-review notes

- **Spec coverage:** one picker (Task 3/5) ✓; agent-or-campaign (scope.ts, Task 1) ✓; default all (Task 5) ✓; interest tabs conditional (Tasks 2/4/5) ✓; share = all-agents (Task 6) ✓; Changelog/Prompt-log untouched (Tasks 5/6 leave them) ✓; subtitle + CSV cleanup (Tasks 5/7) ✓; edge handling — stale id → all (Task 5) ✓; all-mode pagination (Task 2) ✓; tests (Task 8) ✓.
- **Type consistency:** `ReportScope` shape used identically in `scope.ts`, `report-data.ts`, `page.tsx`, share page. `fetchVoiceRows(scope)` / `fetchDashboardKpis({all|agentId|campaignIds})` / `hasInterestData(scope)` / `fetchAgentCampaignIds(agentId)` signatures match every call site. `ReportingTabs` `tabs` prop + `reportingTabsFor` element type align. `scopeSlug` prop added to all three table components and passed by both pages.
- **No migration:** confirmed — all columns/tables already exist.
