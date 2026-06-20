# Smart Lists + Advanced Lead Filters — Design

**Date:** 2026-06-19
**Status:** Approved (design), pending implementation plan
**Owner:** Marija (PM) · built by Claude

## Summary

Give Smile & Dial a Close-CRM-style **advanced lead filter** (nested AND/OR
conditions over status, call activity, custom fields, location, dates, owner),
and let a saved filter become a **Smart List** — a self-updating audience that
auto-includes any new lead matching the filter and can be attached to a
campaign the same way a regular list is.

Built in two releases:

- **Release 1 (#5 — Filters):** advanced filter builder on the Leads page →
  live results + count → export → **Save as Smart List** (saved & reusable for
  viewing/exporting; not yet attachable to a campaign).
- **Release 2 (#4 — Smart Lists):** a background refresh caches each smart
  list's members; a campaign can attach a smart list as a third audience source
  feeding the dialer.

#4 depends on #5: the same filter engine powers both.

## Decisions (locked with Marija, 2026-06-19)

- **Match logic:** full **nested AND/OR groups** (most powerful, Close-style).
- **Freshness:** smart-list membership refreshes **every few minutes** (not
  real-time, not nightly). A freshly imported lead is callable within minutes.
- **Filterable fields:** all categories — status & call activity, custom field
  answers, location, dates & owner.
- **Rollout:** **phased** (filters first, then smart lists + campaign attach).
- **One smart list per campaign** (the recipe itself can be arbitrarily
  complex; can extend to multiple later).
- **Filter builder lives on the Leads page** (not a separate screen).
- **Save as Smart List appears in Release 1**, but campaign attachment is R2.

## The filter "recipe"

A filter is a **tree**: group nodes and condition leaves.

- **Group node:** `{ combinator: "and" | "or", children: Node[] }`. Groups nest.
- **Condition leaf:** `{ field, operator, value }`.

Stored as JSONB on the smart list (and, while building, serialized in the Leads
page state). A closed allow-list of fields + operators (below) — no free-form
SQL, no fragile URL params (this is what sank the earlier custom-field attempt,
PR #163→revert #165: dynamic SELECT broke typing + URL length).

### Field + operator catalog

| Field group                             | Fields                               | Operators                                                  |
| --------------------------------------- | ------------------------------------ | ---------------------------------------------------------- |
| **Status**                              | lead status                          | is · is any of · is not                                    |
| **Call activity**                       | connected-ever, goal met, DM reached | is true · is false                                         |
|                                         | # of attempts                        | = · ≠ · > · < · between                                    |
|                                         | last called                          | before · after · between · **never called** (empty)        |
| **Custom fields** (dropdown/select)     | e.g. AI-answering interest           | is any of · is none of · is empty · has any value          |
| **Custom fields** (text)                | e.g. AI tools, reason                | contains · doesn't contain · is · is empty · has any value |
| **Custom fields** (number/date/boolean) | any custom of that type              | type-appropriate (>, <, between · before/after · is)       |
| **Location**                            | city, state, timezone                | is · is any of · contains                                  |
| **Dates**                               | created/imported                     | before · after · between · in last N days                  |
| **Owner**                               | owner                                | is · is any of                                             |

- The custom-field list is **data-driven** — every `custom_field_defs` row
  becomes a filterable field automatically; new fields need no code change.
- **"is empty / has any value"** covers the AI-tools use case ("call leads
  where Current AI tools has any value", or "…is empty").

## Architecture — one evaluator, three consumers

A single **Postgres function** translates a recipe (JSONB tree) into a safe
query and returns matching lead IDs. Reused everywhere so results can never
disagree:

1. **Leads page (live):** the active recipe → function → IDs → the existing
   leads query restricts with `.in("id", ids)` (literal select; same proven
   shape as today's "Connected" filter). Drives the table + count + export.
2. **Refresh job (R2):** every few minutes, evaluate each active smart list's
   recipe → upsert `smart_list_members`, delete stale rows.
3. **Dialer (R2):** `dial_queue` view reads `smart_list_members` as a third
   audience branch.

### Why a Postgres function (not TS query-building)

The hard conditions (custom-field answers, call activity) need `EXISTS`
subqueries on `lead_custom_values` / `calls`, plus nested AND/OR with
parentheses — which PostgREST/supabase-js can't express cleanly (the #165
gotcha). A DB function evaluates where the data lives, fast, and is the single
source of truth for the page, the refresh, and the dialer.

**Safety:** the function builds dynamic SQL with `format()` using `%I`/`%L`
quoting and an **allow-list** of fields + operators. Values are quoted as
literals; unknown fields/operators are rejected. The function only ever
`select id from leads where <predicate>` — it cannot do anything else.

### Condition → SQL mapping (per leaf)

- **Lead columns** (status, city, state, timezone, owner_id, created_at,
  last_call_at): direct predicate on `leads`.
- **Flags** (connected-ever / goal met / DM reached): `decision_maker_reached`
  is a column; connected-ever = `EXISTS (select 1 from calls where
lead_id = leads.id and outcome = any(CONNECTED_OUTCOMES))`; goal met =
  `leads.status='goal_met' OR EXISTS goal_met call`.
- **# attempts:** `leads.call_attempts <op> n` (already maintained).
- **never called:** `leads.last_call_at is null`.
- **Custom field** `<slug> <op> <value>`:
  `EXISTS (select 1 from lead_custom_values v join custom_field_defs d
on d.id = v.custom_field_id where v.lead_id = leads.id and d.slug = <slug>
and <value-condition on v.value>)`; "is empty" = `NOT EXISTS (…d.slug=<slug>)`.
- Always excludes `deleted_at is not null`.

## Release 1 — Filters on the Leads page

- **Builder UI** above the Leads table: `+ Add condition` (field → operator →
  value, value input adapts to type), `+ Add group` (nesting), per-group
  **All / Any** toggle. Quick/simple filters stay.
- **Live results + count** as conditions change.
- **Export** the filtered set via the existing all-fields export.
- **Save as Smart List** (name + optional description) → stores the recipe.
  Reusable for viewing/exporting in R1.
- **Eval path:** recipe → Postgres function → IDs → `applyLeadFilters` +
  `.in("id", ids)`.

### R1 data

- `smart_lists` table created in R1 (so Save works): id, owner_id, name,
  description, `filter jsonb`, created_at, updated_at. Admin RLS.

## Release 2 — Smart Lists feed campaigns

- **`smart_list_members`** (smart_list_id, lead_id, PK both) — cached
  membership. Indexed on smart_list_id (dialer lookup) and lead_id.
- **Refresh job:** a cron every few minutes (sits beside the existing dialer
  autopilot cron / nightly heatmap recompute). For each smart list attached to
  an active campaign (and any opened in the UI), re-evaluate → upsert/delete
  members. Optionally also kick a refresh right after a lead import for
  immediacy; the cron is the backstop.
- **Campaign attach:** `campaigns.smart_list_id` (nullable FK). Campaign
  settings dialog gains a Smart List picker beside _attach lists_ and _company
  search_, with a **live match count**.
- **Dialer:** `dial_queue` view (migration 20260618120000) gets a third
  membership branch:
  `OR (c.smart_list_id is not null AND EXISTS (select 1 from
smart_list_members m where m.smart_list_id = c.smart_list_id and
m.lead_id = l.id))`. `pre_call_check` re-verifies eligibility as today;
  calling hours, caps, DNC, in-flight guard all unchanged.

## Out of scope (YAGNI for now)

- Multiple smart lists per campaign (one is enough; recipe carries complexity).
- Real-time membership (few-minute refresh chosen).
- Per-user (non-admin) smart lists — admin-scoped like campaigns for now.
- Saving smart lists as "snapshots" (they're always dynamic).

## Testing / verification

No automated CI in this repo (Playwright CI removed — see project memory), so:

- **Filter function:** exercise with sample recipes against known leads via
  `execute_sql` / a PostgREST RPC call; the returned count must match the Leads
  view and the CSV export for the same recipe.
- **Local gates:** `tsc --noEmit`, eslint, `npm run build` before each PR.
- **R2 end-to-end (manual):** attach a smart list to a test campaign → confirm
  `dial_queue` returns exactly the expected leads; confirm caps/hours/DNC still
  gate.
- Ship as separate PRs per release (and per migration), auto-deploying on merge.

## Key files / seams

- `src/app/(app)/leads/leads-query.ts` — `applyLeadFilters` + `.in("id", ids)`
  pattern; add the recipe-IDs restriction.
- New: `src/lib/smart-lists/*` (recipe types, server actions, refresh) and the
  Postgres filter function + `smart_lists` / `smart_list_members` migrations.
- `supabase/migrations/20260618120000_campaign_audience_filter.sql` —
  `dial_queue` view to extend with the third branch.
- `src/app/(app)/campaigns/campaign-settings-dialog.tsx` +
  `src/lib/campaigns/*` — smart-list picker + live count.
- Custom field model: `custom_field_defs` (slug, type, options) +
  `lead_custom_values` (value jsonb) — see memory
  `reference_custom_fields_data_collection`.
