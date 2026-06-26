# Reporting: filter by agent / campaign

**Date:** 2026-06-26
**Status:** Design approved, pending spec review

## Problem

The Reporting hub (`/reporting`) is hard-locked to the **Market Research** agent and
campaign — `page.tsx` literally resolves the agent/campaign by name
(`ilike "%market research%"`) and every tab shows only that data. There is no way to
see reporting for any other agent or campaign.

Two of the five tabs — **Voice of Customer** and **Hot Leads** — are built entirely on
an interest field (`extracted_data.ai_call_answering_interest` → `yes`/`no`/`maybe`)
that **only the Market Research agent produces**. Other agents don't collect it, so
those tabs are meaningless for them. The **Dashboard** tab, by contrast, is already
generic (calls, connected, conversations, decision-makers reached, callbacks, goals,
warm %) and its data function already accepts an agent/campaign scope — it's just never
given anything but Market Research.

## Goal

Add a scope filter so an admin can pick an agent or a campaign and have the reporting
re-compute for that selection, while gracefully handling the tabs that only make sense
for an agent that collects interest.

## Decisions (from brainstorming)

1. **One picker** that selects _either_ an agent (rolls up its campaigns) _or_ a single
   campaign.
2. **Agents without the interest field show the generic Dashboard only.** The
   interest-based tabs (Voice of Customer, Hot Leads) appear only when the selected
   scope actually has interest data.
3. **Default view = All agents combined** (workspace-wide overview).
4. **Public share link shows the all-agents combined view** (Market-Research lock
   removed there too). Confirmed acceptable that external recipients now see all agents.
5. **Changelog and Agent Prompt Log stay always-visible and unfiltered** in this phase.

## Non-goals (explicitly deferred)

- Generalizing the interest field into "whatever structured fields each agent collects"
  (the per-agent custom-field reporting). Future phase.
- Tying App Changelog / Agent Prompt Log to the picker, or scoping them per agent.
  "Other tabs later."
- Per-selection share links (sharing a specific agent's report). Share stays a fixed
  all-agents overview.
- Remembering the user's last selection. Always defaults to All.

## The scope model

A single value describes what's being reported on:

```
type ReportScope =
  | { kind: "all" }
  | { kind: "agent"; agentId: string }
  | { kind: "campaign"; campaignId: string }
```

Carried in the URL query string, mirroring the Dashboard's existing `?day=` pattern:

- `?scope=all` (default when absent)
- `?scope=agent:<uuid>`
- `?scope=campaign:<uuid>`

URL-based means server-rendered, refresh-safe, and shareable as a link. The `day`
param continues to work alongside it.

## Components & changes

### Picker — new component `scope-picker.tsx`

A single combobox at the top of the page, above the tabs, persistent across tabs.
Options:

- **All agents (combined)** — default
- each agent (label: agent name)
- each campaign (visually grouped/labelled as campaigns so it's distinct from agents)

Selecting an option navigates to the same page with the new `?scope=` value (preserving
`day` where present). `page.tsx` loads the full agent + campaign lists to populate it
(replacing today's by-name lookup).

### Tab visibility — `reporting-tabs.tsx`

The Voice of Customer and Hot Leads tabs render only when the current scope has interest
data. Determined by a cheap existence check (below), **not** by matching the name
"Market Research." Consequence: if another agent ever starts collecting
`ai_call_answering_interest`, its interest tabs appear automatically with no code change.

### Dashboard — scope-aware (already mostly there)

`fetchDashboardKpis` already takes `{ agentId?, campaignIds? }`. Changes:

- Add an **"all" mode**: today the function returns `[]` when no scope is given
  (`report-data.ts:112`). Add an explicit all path that queries every outbound call in
  the window (no agent/campaign filter), still paginated past the 1,000-row cap.
- Map scope → args:
  - `all` → all mode
  - `agent:<id>` → `{ agentId, campaignIds: <that agent's campaign ids> }` (passing both
    keeps totals durable if the agent row is later deleted — same reasoning as the
    current Market Research call)
  - `campaign:<id>` → `{ campaignIds: [id] }`

### Voice of Customer — `fetchVoiceRows` takes a scope

Generalize `fetchVoiceRows(supabase, agentId)` → `fetchVoiceRows(supabase, scope)`:

- `all` → no agent/campaign filter (all interest calls in window)
- `agent:<id>` → `.eq("agent_id", id)`
- `campaign:<id>` → `.eq("campaign_id", id)`

The `extracted_data->>ai_call_answering_interest is not null` filter stays. Window stays
`VOICE_DAYS = 30`.

### Hot Leads — stays global

`fetchHotLeadRows` remains unscoped (the `hot_leads` table is seeded only from Market
Research "yes" calls and carries no campaign/agent column). It renders whenever the
interest tabs are shown (All or a scope with interest data). Campaign-level hot-lead
filtering is out of scope.

### Interest-data check — new helper `hasInterestData(supabase, scope)`

A lightweight existence query: select one `calls` row in the scope's window where
`extracted_data->>ai_call_answering_interest is not null` (head/count, limit 1). Returns
a boolean that drives tab visibility. Cheap — no row aggregation.

### Public share — `share/reporting/[token]/page.tsx`

Remove the `ilike "%market research%"` scoping; render the **all-agents combined** view
(Dashboard for all calls + the interest tabs, which surface the interest data that
exists). Read-only, **no picker**. Same `day` stepper behavior as today.

### Wording & cosmetic cleanup

- Replace the "Currently covering the Market Research agent" subtitle with the picker.
- CSV export filenames become scope-aware: `all-agents-…`, `<agent-slug>-…`, or
  `<campaign-slug>-…` instead of the hardcoded `market-research-…`
  (`dashboard-view.tsx`, `voice-table.tsx`, `hot-leads-table.tsx`).
- Update the "no agent named Market Research found" empty state — no longer reachable
  the same way; replace with a neutral empty state for an empty scope.

## Data flow

```
URL ?scope=…  ──►  page.tsx parses ReportScope
                     │
                     ├─► load agents + campaigns ──► <ScopePicker/>
                     │
                     ├─► hasInterestData(scope) ──► which tabs to render
                     │
                     ├─► Dashboard tab  ──► fetchDashboardKpis(scope→args)
                     ├─► Voice tab      ──► fetchVoiceRows(scope)        [if interest]
                     └─► Hot Leads tab  ──► fetchHotLeadRows()           [if interest]

Changelog / Prompt Log: unchanged, always rendered, no scope.
```

## Error / edge handling

- **Unknown or malformed `scope` param** → fall back to `all`.
- **Selected agent/campaign deleted** → picker no longer lists it; if its id is still in
  the URL, treat as not-found and fall back to `all` (don't error the page).
- **Scope has zero calls** → Dashboard renders its normal empty/zero state; interest
  tabs simply don't appear (no interest data).
- **`all` mode + 1,000-row cap** → the all-mode query paginates like the scoped path, so
  workspace-wide totals stay correct (consistent with the costs/analytics row-cap fixes).

## Testing (Playwright, runs against live env)

- Switching the picker to a different agent changes the Dashboard numbers (scope flows
  through the URL and re-renders).
- For an agent with no interest data, the Voice of Customer + Hot Leads tabs are **not**
  rendered; for **All** and **Market Research** they **are**.
- The share page renders the all-agents Dashboard (no Market-Research lock, no picker).
- Default load (no `scope` param) shows All agents combined.

## Out-of-scope file touch summary (for the plan)

- `src/app/(app)/reporting/page.tsx` — parse scope, load agents+campaigns, wire picker,
  gate tabs on `hasInterestData`, remove MR-by-name lock.
- `src/app/(app)/reporting/reporting-tabs.tsx` — conditional interest tabs.
- `src/app/(app)/reporting/scope-picker.tsx` — **new** component.
- `src/app/share/reporting/[token]/page.tsx` — all-agents view, remove MR lock.
- `src/lib/agent-analytics/report-data.ts` — `fetchDashboardKpis` all mode,
  `fetchVoiceRows(scope)`, new `hasInterestData`, scope→args mapping helpers.
- `src/app/(app)/reporting/{dashboard-view,voice-table,hot-leads-table}.tsx` —
  scope-aware CSV filenames.
- `tests/` — extend the reporting spec.
