# Reporting redesign — Phase 1: campaign-only filter + dashboard fix + changelog

**Date:** 2026-06-26
**Status:** Design approved, pending spec review

Phase 1 of a 3-phase Reporting redesign (follow-up to PRs #226 / #227). Phases 2
and 3 are out of scope here (see Non-goals).

## Problem

After shipping the agent/campaign filter, three issues remain:

1. The Dashboard's daily-history table shows **Yes / Maybe / No / Warm %** columns
   for every selection, even campaigns/agents with no sentiment data (screenshot:
   a 3-call campaign showing those columns all-zero).
2. Filtering by **agent** is more confusing than useful — the interest/sentiment
   data is campaign-bound, and an agent can have orphaned (null-agent) calls.
3. The **App Changelog** is an editable timeline; it should be a clean read-only
   list, newest first, without the Owner field.

## Decisions (approved)

1. **Filter is campaigns-only.** Drop the agent option. Scope is `all` or one
   campaign. Default = **All campaigns (combined)**. Public share = all-campaigns
   combined.
2. **Dashboard sentiment columns render only for a single campaign that has
   sentiment data.** Hidden in the combined view and for campaigns without it.
   (Phase 2 will relabel them per campaign, e.g. Happy/Mixed/Unhappy.)
3. **App Changelog → read-only table/list:** newest first, no Owner column,
   existing rows display-only. Admin can still **Add** an entry. The `owner` DB
   column is retained but unused (no migration).
4. Voice of Customer & Hot Leads tabs keep their current (interest-driven) logic
   for now — they simply follow the campaign scope and the combined-view note
   stays. Their redesign is Phase 2/3.

## Non-goals (Phase 2/3, explicitly deferred)

- Generalizing Voice of Customer / Hot Leads (or the dashboard sentiment labels)
  to each campaign's own collected fields (Happy/Mixed/Unhappy, etc.).
- Call-recording playback; clickable lead names.
- Hot Leads redesign (yes+maybe seeding, delete button, list column, stripped
  columns).
- Dropping the unused `owner` column from `app_changelog`.

## The scope model (simplified)

`ReportScope` loses the `agent` variant:

```
type ReportScope = { kind: "all" } | { kind: "campaign"; campaignId: string };
```

URL: `?scope=all` (default) or `?scope=campaign:<uuid>`. A stale/unknown id →
`all`. `parseScopeParam` drops the `agent:` branch; `serializeScope` drops the
agent case.

## Components & changes

### `src/lib/agent-analytics/scope.ts`

- Remove the `agent` member from `ReportScope`.
- `parseScopeParam`: drop the `agent:` handling (anything not `campaign:<id>` → `all`).
- `serializeScope`: drop the agent case.

### `src/lib/agent-analytics/report-data.ts`

- `scopeCallConds`: simplify to `null` for all, `campaign_id.eq.<id>` for a
  campaign. Remove the agent-rollup branch.
- **Remove** `fetchAgentCampaignIds` (only the agent scope used it).
- `fetchDashboardKpis`: still takes `{ all?; campaignIds? }`; called with
  `{ all: true }` or `{ campaignIds: [id] }`. (The `agentId` field becomes dead;
  drop it from `DashboardKpiScope`.)
- `fetchVoiceRows(scope)` / `hasInterestData(scope)`: unchanged except they now
  only ever see `all` / `campaign` (via the simplified `scopeCallConds`).

### `src/app/(app)/reporting/scope-picker.tsx`

- Drop the `agents` prop and the **Agents** `SelectGroup`. Keep **All campaigns
  (combined)** + a **Campaigns** group. The "all" item label becomes
  "All campaigns (combined)".

### `src/app/(app)/reporting/page.tsx`

- Load **campaigns only** (drop the agents query) for the picker + validation.
- Parse scope (`all` | `campaign`); validate the campaign id against the list,
  else fall back to `all`.
- `kpiScope = scope.kind === "all" ? { all: true } : { campaignIds: [scope.campaignId] }`.
- **Dashboard sentiment gate:** `showSentiment = scope.kind === "campaign" &&
(await hasInterestData(supabase, scope))`. Pass `showSentiment` to `DashboardView`.
- Tabs/note logic unchanged (still `hasInterestData`-driven + `INTEREST_COMBINED_NOTE`).

### `src/app/(app)/reporting/dashboard-view.tsx`

- Accept `showSentiment?: boolean` (default `false`). Conditionally render the
  Yes / Maybe / No / Warm % column **headers and cells** only when `showSentiment`.
  All other columns unchanged. CSV export drops those columns when hidden so the
  file matches the table.

### `src/app/(app)/reporting/changelog-table.tsx`

- Replace the vertical timeline with a simple table/list matching the other tabs:
  columns **Date · Type · Status · Summary · Details · Area · Ticket** (no Owner).
- Rows are **display-only** (remove all inline inputs, the per-field `commit`, and
  the per-row delete). Sort newest first (the data already returns
  `change_date desc, created_at desc`).
- Keep an **Add entry** affordance for admins (the existing create flow, minus the
  Owner field). On the public share it renders read-only with no Add.
- This means the table no longer calls the update/delete changelog actions; those
  server actions remain in `actions.ts` (unused, removed in a later cleanup) — the
  create action drops the `owner` argument.

### `src/lib/agent-analytics/report-data.ts` (ChangelogRow)

- `ChangelogRow` keeps `owner` in the type for now (harmless) or drop it from the
  mapping; the table simply won't render it. (Prefer: stop selecting/mapping
  `owner` to keep the row lean.)

### `src/app/share/reporting/[token]/page.tsx`

- Already all-campaigns; verify the changelog renders in the new read-only table
  form (it passes `readOnly`).

## Error / edge handling

- Unknown/malformed `?scope=` → `all`.
- `?scope=campaign:<deleted id>` → not in the loaded list → fall back to `all`.
- Combined view → `showSentiment` is false → dashboard sentiment columns hidden.

## Testing (Playwright, live env only)

- Update `tests/reporting-scope.spec.ts`: the picker offers **All campaigns** +
  campaigns (no agent options); selecting a campaign with sentiment data shows the
  dashboard sentiment columns, a campaign without (or the combined view) hides them.
- Changelog tab renders as a read-only list with no Owner column and an Add control
  for admins.

## Verification gates (run locally)

`npx tsc --noEmit`, `npx eslint`, `npm run build` — all clean on changed files
(only the 3 pre-existing `twilio-*.spec.ts` tsc errors allowed). No DB migration.
