# Reporting redesign — Phase 3: Hot Leads as a live warm-calls list

**Date:** 2026-06-26
**Status:** Design approved, pending spec review

Phase 3 (final) of the Reporting redesign (Phases 1–2 = #228, #229).

## Problem

Hot Leads is a separately-seeded table (one row per Market Research "yes" call,
created by a post-call seeder) with team-edit columns (status/owner/next-step/
contacted). It's Market-Research-only and cluttered. We want it generalized to
any campaign, simplified to a clean actionable list, and removable.

## Decisions (approved)

1. **Live list, not seeded.** For the selected campaign, Hot Leads is the
   campaign's **warm calls** — sentiment positive _or_ neutral (yes+maybe,
   happy+mixed) via the Phase 2 lexicon (`isWarm`) — computed live like Voice of
   Customer. No more per-call seeding.
2. **Delete = permanent hide**, stored in a new `hot_lead_dismissals(call_id)`
   table (small additive migration).
3. **Columns:** Date · Company · Contact · Why hot · List · Delete.
   - Company → `/leads/<id>` on admin; plain text on the public share.
   - Contact = the lead's contact name (`owner_name` → `manager_name` →
     `employee_name`).
   - Why hot = the campaign's detected notes field (same as Voice of Customer).
   - List = the lead's list name (replaces the old "Length").
   - Removed: current AI tool, status, owner, next step, contacted, and the
     status filter. A simple search box stays.
4. **Visibility:** only when a single campaign with detected sentiment is
   selected (hidden in the combined view), matching Voice of Customer. Read-only
   on the public share (no delete, no lead link).
5. **Window:** warm calls from the last 30 days (matches Voice of Customer).
6. **Cleanup:** stop calling the old `seedHotLeadFromCall` seeder in the post-call
   webhook; the old `hot_leads` table is left in place (unused, not dropped).
   `hasInterestData` (MR-specific tab gate) is replaced and removed.

## Non-goals

- Dropping the old `hot_leads` table or its team-edit columns (left in place).
- Undo for delete; bulk delete.
- Per-campaign override of which sentiment values count as "warm" (the lexicon
  decides; unrecognized values are not warm).

## Migration (additive — apply before deploy)

`supabase/migrations/<ts>_hot_lead_dismissals.sql`:

```sql
create table if not exists public.hot_lead_dismissals (
  call_id uuid primary key references public.calls (id) on delete cascade,
  dismissed_by uuid references auth.users (id),
  dismissed_at timestamptz not null default now()
);
alter table public.hot_lead_dismissals enable row level security;
-- Admin-only read (writes go through a service-role server action with an
-- in-code admin check, mirroring the other Agent Analytics tables).
create policy "admins read hot_lead_dismissals"
  on public.hot_lead_dismissals for select
  using (public.is_admin(auth.uid()));
```

Regenerate `database.types.ts` (add the table) after applying.

## Components & changes

### Data layer — `src/lib/agent-analytics/report-data.ts`

- `HotLeadRow` reshape:
  ```ts
  export type HotLeadRow = {
    id: string; // call id
    day: string; // ET day
    company: string;
    contact: string; // lead owner/manager/employee name
    whyHot: string; // detected notes field value
    list: string;
    leadId: string | null;
  };
  ```
- `fetchHotLeadRows(supabase, scope, detected)`:
  - Return `[]` unless `scope.kind === "campaign"` and `detected.sentimentKey`
    and there is ≥1 warm value.
  - `warmValues = detected.sentimentValues.filter(isWarm)`.
  - Query the campaign's outbound calls in the 30-day window where
    `extracted_data->>sentimentKey` ∈ `warmValues` (`.in(...)`), newest first,
    joining `lead:leads(company, owner_name, manager_name, employee_name,
list:lists(name))` and selecting `id, started_at, lead_id, extracted_data,
recording_path?`(not needed) — map to `HotLeadRow`. `contact` = first
    non-empty of owner/manager/employee name. `whyHot` = `extracted_data[notesKey]`.
  - Exclude dismissed: collect candidate call ids, query
    `hot_lead_dismissals.select(call_id).in("call_id", ids)`, drop matches.

### Delete action — `src/lib/agent-analytics/actions.ts`

- New `dismissHotLead({ callId }): Promise<{ error }>` — admin-checked,
  service-role `insert` into `hot_lead_dismissals` (upsert/ignore-duplicate on
  `call_id`), `revalidatePath("/reporting")`.
- Remove the now-dead `saveHotLeadField` action (its columns are gone).

### Seeder cleanup

- Remove the `seedHotLeadFromCall` call from the post-call webhook
  (`src/lib/elevenlabs/post-call-webhook.ts`). The helper file
  `src/lib/agent-analytics/hot-leads.ts` becomes unused — delete it (and the
  `scripts/backfill-hot-leads.mjs` reference is untouched; it's a one-off script).

### Tab visibility — `src/app/(app)/reporting/reporting-tabs.tsx` + pages

- `showHotLeads = scope.kind === "campaign" && detected.sentimentKey !== null &&
detected.sentimentValues.some(isWarm)`. (Same `reportingTabsFor({showVoice,
showHotLeads})` shape.)
- Remove `hasInterestData` from `report-data.ts` and its imports in page/share
  (no longer used once Hot Leads is generalized).

### Table — `src/app/(app)/reporting/hot-leads-table.tsx` (rewrite)

- Props: `{ rows: HotLeadRow[]; readOnly?: boolean; scopeSlug?: string }`.
- Columns Date · Company (Link to `/leads/<leadId>` unless `readOnly`) · Contact ·
  Why hot · List · (Delete button, admin only, with `window.confirm`, calling
  `dismissHotLead`). Search box over company/contact/whyHot. CSV export of the
  visible columns. Remove all status/owner/next-step/date editing, the status
  filter, `saveHotLeadField`, `fmtLen`, `current_ai_tool`.

### Pages

- `page.tsx`: `HotLeadsTab` takes `scope` + `detected` + `slug`, calls
  `fetchHotLeadRows(supabase, scope, detected)`; gate via `showHotLeads`.
- `share/.../page.tsx`: same, `readOnly`, recording/lead-link rules already handled
  by `readOnly`.

## Error / edge handling

- Campaign without sentiment / no warm values → Hot Leads tab hidden.
- Dismissing a call already dismissed → ignore-duplicate (no error).
- Deleting a call row (cascade) removes its dismissal automatically.
- Combined view / share-combined → tab hidden.

## Testing (Playwright, live env only)

Extend `tests/reporting-scope.spec.ts`:

- For a campaign with warm calls, the Hot Leads tab lists them with Company linked
  to `/leads/<id>`, a Contact, Why hot, and List column; no "Status"/"Owner"
  headers.
- `dismissHotLead` (via the delete button, or asserting the row disappears after
  inserting a dismissal) hides the row.
- A campaign with no warm sentiment → no Hot Leads tab.

## Verification gates (run locally)

`npx tsc --noEmit`, `npx eslint`, `npm run build` — clean on changed files (only
the 3 pre-existing `twilio-*.spec.ts` errors). **One migration** (apply before
merge/deploy); regenerate `database.types.ts`.
