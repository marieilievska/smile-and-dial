# Reporting redesign Phase 3 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Hot Leads a live, per-campaign list of "warm" calls (positive/neutral sentiment) with a permanent Delete, generalized like Voice of Customer — and retire the old per-call seeder.

**Architecture:** Hot Leads is computed live from the campaign's warm calls (lexicon `isWarm`), minus a new `hot_lead_dismissals` table that records deleted calls. The post-call seeder + the MR-specific `hasInterestData` gate are removed.

**Tech Stack:** Next.js (App Router/RSC), Supabase (PostgREST), shadcn, Playwright (live-env).

**Testing note:** No local test runner — Playwright runs against the live env only. Each task verifies with `npx tsc --noEmit` + `npx eslint <files>` (and `npm run build` on page tasks). Shared-signature changes cause transient mid-plan tsc errors; clean (except the 3 pre-existing `twilio-*.spec.ts`) after the final task.

**Branch:** `feat/reporting-phase3-hot-leads` (created; spec committed).

**Migration:** ONE additive migration (`hot_lead_dismissals`). The coordinator applies it with `supabase db push` BEFORE merge/deploy; this plan also hand-edits `database.types.ts` so `tsc` passes locally.

---

## File structure

- **Create** `supabase/migrations/<ts>_hot_lead_dismissals.sql` — the dismissals table.
- **Modify** `src/lib/supabase/database.types.ts` — add the `hot_lead_dismissals` table types.
- **Modify** `src/lib/agent-analytics/report-data.ts` — `HotLeadRow` reshape; `fetchHotLeadRows(scope, detected)`; `leadInfo` helper; remove `hasInterestData`, `fmtLen`, `HotLeadRawRow`.
- **Modify** `src/lib/agent-analytics/actions.ts` — add `dismissHotLead`; remove `saveHotLeadField`.
- **Modify** `src/lib/elevenlabs/post-call-webhook.ts` — remove the `seedHotLeadFromCall` call + import.
- **Delete** `src/lib/agent-analytics/hot-leads.ts` — the seeder (now unused).
- **Rewrite** `src/app/(app)/reporting/hot-leads-table.tsx` — simple list + delete + lead link + search.
- **Modify** `src/app/(app)/reporting/page.tsx` — `showHotLeads` from detection; `HotLeadsTab(scope, detected, slug)`; drop `hasInterestData`.
- **Modify** `src/app/share/reporting/[token]/page.tsx` — same, read-only.
- **Modify** `tests/reporting-scope.spec.ts` — hot-leads assertions.

---

## Task 1: Dismissals table (migration + types)

**Files:**

- Create `supabase/migrations/20260626140000_hot_lead_dismissals.sql`
- Modify `src/lib/supabase/database.types.ts`

- [ ] **Step 1: Write the migration**

```sql
-- Hot Leads is now a live list of a campaign's "warm" calls (Reporting Phase 3).
-- Deleting one permanently hides that call from the list — recorded here. The old
-- seeded public.hot_leads table is left in place (unused) and not dropped.
create table if not exists public.hot_lead_dismissals (
  call_id uuid primary key references public.calls (id) on delete cascade,
  dismissed_by uuid references auth.users (id),
  dismissed_at timestamptz not null default now()
);
alter table public.hot_lead_dismissals enable row level security;
-- Admin-only read; writes go through a service-role server action with an in-code
-- admin check, mirroring the other Agent Analytics tables.
create policy "admins read hot_lead_dismissals"
  on public.hot_lead_dismissals for select
  using (public.is_admin(auth.uid()));
```

- [ ] **Step 2: Add the table to `database.types.ts`**

Find the `hot_leads:` table block in the `Tables` object and add a sibling `hot_lead_dismissals` block immediately before it (alphabetical order keeps `hot_lead_dismissals` before `hot_leads`):

```ts
      hot_lead_dismissals: {
        Row: {
          call_id: string;
          dismissed_at: string;
          dismissed_by: string | null;
        };
        Insert: {
          call_id: string;
          dismissed_at?: string;
          dismissed_by?: string | null;
        };
        Update: {
          call_id?: string;
          dismissed_at?: string;
          dismissed_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "hot_lead_dismissals_call_id_fkey";
            columns: ["call_id"];
            isOneToOne: true;
            referencedRelation: "calls";
            referencedColumns: ["id"];
          },
        ];
      };
```

- [ ] **Step 3: Verify** — `npx tsc --noEmit` (no new errors from the types edit); `npx eslint src/lib/supabase/database.types.ts` clean.
- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260626140000_hot_lead_dismissals.sql src/lib/supabase/database.types.ts
git commit -m "feat(reporting): hot_lead_dismissals table + generated types"
```

---

## Task 2: Data layer — live warm-calls Hot Leads

**Files:** Modify `src/lib/agent-analytics/report-data.ts`

- [ ] **Step 1: Reshape `HotLeadRow`**

Replace the `HotLeadRow` type:

```ts
export type HotLeadRow = {
  id: string; // call id
  day: string;
  company: string;
  contact: string;
  whyHot: string;
  list: string;
  leadId: string | null;
};
```

- [ ] **Step 2: Add a `leadInfo` helper** (next to `leadCompany`)

```ts
function leadInfo(lead: unknown): {
  company: string;
  contact: string;
  list: string;
} {
  const l = Array.isArray(lead) ? lead[0] : lead;
  const obj = l && typeof l === "object" ? (l as Record<string, unknown>) : {};
  const s = (k: string) =>
    typeof obj[k] === "string" ? (obj[k] as string).trim() : "";
  const company = s("company");
  const contact = s("owner_name") || s("manager_name") || s("employee_name");
  const listRaw = Array.isArray(obj.list) ? obj.list[0] : obj.list;
  const listObj =
    listRaw && typeof listRaw === "object"
      ? (listRaw as Record<string, unknown>)
      : {};
  const list = typeof listObj.name === "string" ? listObj.name : "";
  return { company, contact, list };
}
```

- [ ] **Step 3: Import `isWarm` + rewrite `fetchHotLeadRows`**

Add `isWarm` to the `./field-detect` import (alongside `type DetectedFields`). Replace `fetchHotLeadRows` (and delete the now-unused `HotLeadRawRow` type above it):

```ts
export async function fetchHotLeadRows(
  supabase: DB,
  scope: ReportScope,
  detected: DetectedFields,
): Promise<HotLeadRow[]> {
  if (scope.kind !== "campaign" || !detected.sentimentKey) return [];
  const warmValues = detected.sentimentValues.filter(isWarm);
  if (warmValues.length === 0) return [];
  const sentimentKey = detected.sentimentKey;

  const { data } = await supabase
    .from("calls")
    .select(
      "id, started_at, lead_id, extracted_data, lead:leads(company, owner_name, manager_name, employee_name, list:lists(name))",
    )
    .eq("campaign_id", scope.campaignId)
    .eq("direction", "outbound")
    .gte("started_at", sinceDaysAgoIso(VOICE_DAYS))
    .in(`extracted_data->>${sentimentKey}`, warmValues)
    .order("started_at", { ascending: false })
    .limit(2000);

  type Raw = {
    id: string;
    started_at: string | null;
    lead_id: string | null;
    extracted_data: unknown;
    lead: unknown;
  };
  const rows = (data ?? []) as unknown as Raw[];
  if (rows.length === 0) return [];

  // Exclude dismissed calls (chunk the id lookup past the 1,000-row cap).
  const ids = rows.map((r) => r.id);
  const dismissed = new Set<string>();
  for (let i = 0; i < ids.length; i += 1000) {
    const { data: dis } = await supabase
      .from("hot_lead_dismissals")
      .select("call_id")
      .in("call_id", ids.slice(i, i + 1000));
    for (const d of dis ?? [])
      dismissed.add((d as { call_id: string }).call_id);
  }

  return rows
    .filter((r) => !dismissed.has(r.id))
    .map((r): HotLeadRow => {
      const ed =
        r.extracted_data && typeof r.extracted_data === "object"
          ? (r.extracted_data as Record<string, unknown>)
          : {};
      const info = leadInfo(r.lead);
      return {
        id: r.id,
        day: r.started_at ? etDay(r.started_at) : "",
        company: info.company,
        contact: info.contact,
        whyHot: detected.notesKey
          ? String(ed[detected.notesKey] ?? "").trim()
          : "",
        list: info.list,
        leadId: r.lead_id,
      };
    });
}
```

- [ ] **Step 4: Remove `hasInterestData` + `fmtLen`**

Delete the `hasInterestData` function entirely (callers are removed in Tasks 6–7). Delete the `fmtLen` helper (only the old Hot Leads used it). If eslint flags any now-unused import (`interestOf` is already gone), remove it.

- [ ] **Step 5: Verify** — `npx eslint src/lib/agent-analytics/report-data.ts` clean; tsc flags page/share/table until later tasks.
- [ ] **Step 6: Commit**

```bash
git add src/lib/agent-analytics/report-data.ts
git commit -m "feat(reporting): hot leads = live warm calls minus dismissals"
```

---

## Task 3: Dismiss action; drop saveHotLeadField

**Files:** Modify `src/lib/agent-analytics/actions.ts`

- [ ] **Step 1: Replace `saveHotLeadField` with `dismissHotLead`**

Delete the whole `saveHotLeadField` function and add:

```ts
/** Permanently hide a call from Hot Leads. Admin-only; idempotent (upsert on the
 *  call_id primary key). */
export async function dismissHotLead(input: {
  callId: string;
}): Promise<{ error: string | null }> {
  if (!(await isCallerAdmin())) return { error: "Admins only." };
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { error } = await adminClient()
    .from("hot_lead_dismissals")
    .upsert(
      { call_id: input.callId, dismissed_by: user?.id ?? null },
      { onConflict: "call_id" },
    );
  if (error) return { error: "Could not remove from Hot Leads." };
  revalidatePath(AGENT_ANALYTICS_PATH);
  return { error: null };
}
```

(`createClient`, `adminClient`, `isCallerAdmin`, `revalidatePath`, `AGENT_ANALYTICS_PATH` are already imported/defined in this file.)

- [ ] **Step 2: Verify** — `npx eslint src/lib/agent-analytics/actions.ts` clean; tsc flags the old `saveHotLeadField` caller (hot-leads-table) until Task 5.
- [ ] **Step 3: Commit**

```bash
git add src/lib/agent-analytics/actions.ts
git commit -m "feat(reporting): dismissHotLead action; remove saveHotLeadField"
```

---

## Task 4: Retire the seeder

**Files:**

- Modify `src/lib/elevenlabs/post-call-webhook.ts`
- Delete `src/lib/agent-analytics/hot-leads.ts`

- [ ] **Step 1: Remove the seeder call + import**

In `post-call-webhook.ts`, delete the import line `import { seedHotLeadFromCall } from "@/lib/agent-analytics/hot-leads";` and delete the whole `await seedHotLeadFromCall(...)` block (the call + its comment, around lines 1061–1072). Leave `autoFillLeadFromExtraction` and the lead-custom-field mirroring around it untouched (`cleanedExtraction` / `callDurationSecs` stay used by that surrounding code).

- [ ] **Step 2: Delete the seeder file**

```bash
git rm src/lib/agent-analytics/hot-leads.ts
```

(First grep to confirm no other importers: `grep -rn "agent-analytics/hot-leads" src/` should return nothing after Step 1. The `scripts/backfill-hot-leads.mjs` standalone script does not import this module — leave it.)

- [ ] **Step 3: Verify** — `npx tsc --noEmit` (no new errors from these); `npx eslint src/lib/elevenlabs/post-call-webhook.ts` clean.
- [ ] **Step 4: Commit**

```bash
git add src/lib/elevenlabs/post-call-webhook.ts src/lib/agent-analytics/hot-leads.ts
git commit -m "chore(reporting): retire the per-call hot-lead seeder"
```

---

## Task 5: Rewrite the Hot Leads table

**Files:** Rewrite `src/app/(app)/reporting/hot-leads-table.tsx`

- [ ] **Step 1: Replace the whole file**

```tsx
"use client";

import { useMemo, useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { dismissHotLead } from "@/lib/agent-analytics/actions";
import type { HotLeadRow } from "@/lib/agent-analytics/report-data";

import { ExportCsvButton } from "./export-csv-button";

export type { HotLeadRow };

/** Hot Leads — the selected campaign's warm calls (positive/neutral sentiment),
 *  newest first. Admins can open the lead and delete a row (permanent hide).
 *  `readOnly` (public share) drops the lead link + delete. */
export function HotLeadsTable({
  rows,
  readOnly = false,
  scopeSlug = "all-campaigns",
}: {
  rows: HotLeadRow[];
  readOnly?: boolean;
  scopeSlug?: string;
}) {
  const [q, setQ] = useState("");
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [, startTransition] = useTransition();

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (removed.has(r.id)) return false;
      if (!needle) return true;
      return (
        r.company.toLowerCase().includes(needle) ||
        r.contact.toLowerCase().includes(needle) ||
        r.whyHot.toLowerCase().includes(needle)
      );
    });
  }, [rows, q, removed]);

  function remove(id: string) {
    if (!window.confirm("Remove this lead from Hot Leads?")) return;
    setRemoved((s) => new Set(s).add(id)); // optimistic
    startTransition(async () => {
      const res = await dismissHotLead({ callId: id });
      if (res.error) {
        toast.error(res.error);
        setRemoved((s) => {
          const n = new Set(s);
          n.delete(id);
          return n;
        });
        return;
      }
      toast.success("Removed");
    });
  }

  const exportRows = filtered.map((r) => [
    r.day,
    r.company,
    r.contact,
    r.whyHot,
    r.list,
  ]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-muted-foreground text-sm">
          Warm leads from the last 30 days (yes / maybe). Work them, then remove
          the ones you&apos;ve handled.
        </p>
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search company, contact, why hot…"
          className="ml-auto h-8 w-[16rem]"
        />
        <ExportCsvButton
          filename={`${scopeSlug}-hot-leads.csv`}
          headers={["day", "company", "contact", "why_hot", "list"]}
          rows={exportRows}
        />
      </div>

      {filtered.length === 0 ? (
        <div className="border-border text-muted-foreground rounded-2xl border border-dashed px-6 py-12 text-center text-sm">
          No hot leads.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-muted-foreground bg-muted/30 text-left text-[10px] tracking-wide uppercase">
                <th className="rounded-l-md px-3 py-2 font-medium whitespace-nowrap">
                  Date
                </th>
                <th className="px-3 py-2 font-medium">Company</th>
                <th className="px-3 py-2 font-medium whitespace-nowrap">
                  Contact
                </th>
                <th className="px-3 py-2 font-medium">Why hot</th>
                <th className="px-3 py-2 font-medium whitespace-nowrap">
                  List
                </th>
                {!readOnly ? (
                  <th className="rounded-r-md px-3 py-2 font-medium whitespace-nowrap">
                    <span className="sr-only">Remove</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr
                  key={r.id}
                  className="border-border/60 hover:bg-muted/30 border-b align-top transition-colors"
                >
                  <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                    {r.day}
                  </td>
                  <td className="text-foreground px-3 py-2 font-medium">
                    {!readOnly && r.leadId ? (
                      <Link
                        href={`/leads/${r.leadId}`}
                        className="hover:text-primary hover:underline"
                      >
                        {r.company || "—"}
                      </Link>
                    ) : (
                      r.company || "—"
                    )}
                  </td>
                  <td className="text-muted-foreground px-3 py-2 whitespace-nowrap">
                    {r.contact || "—"}
                  </td>
                  <td className="text-muted-foreground px-3 py-2">
                    {r.whyHot || "—"}
                  </td>
                  <td className="text-muted-foreground px-3 py-2 whitespace-nowrap">
                    {r.list || "—"}
                  </td>
                  {!readOnly ? (
                    <td className="px-3 py-2 whitespace-nowrap">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => remove(r.id)}
                        aria-label="Remove from Hot Leads"
                        className="text-muted-foreground hover:text-destructive size-8"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </td>
                  ) : null}
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

- [ ] **Step 2: Verify** — `npx tsc --noEmit` clean for this file; `npx eslint "src/app/(app)/reporting/hot-leads-table.tsx"` clean.
- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/reporting/hot-leads-table.tsx"
git commit -m "feat(reporting): hot leads list = date/company/contact/why-hot/list + delete"
```

---

## Task 6: Wire the admin page

**Files:** Modify `src/app/(app)/reporting/page.tsx`

- [ ] **Step 1: Imports**

Remove `hasInterestData` from the `report-data` import. Add `isWarm` to the `field-detect` import (alongside `detectCampaignFields`, `type DetectedFields`).

- [ ] **Step 2: `showHotLeads` gate**

Replace the line that computes `showHotLeads` (currently `scope.kind === "campaign" && (await hasInterestData(supabase, scope))`) with:

```tsx
const showHotLeads =
  scope.kind === "campaign" &&
  detected.sentimentKey !== null &&
  detected.sentimentValues.some(isWarm);
```

- [ ] **Step 3: Pass scope/detected to the Hot Leads tab**

Change the render `<HotLeadsTab />` to `<HotLeadsTab scope={scope} detected={detected} slug={slug} />`, and replace the `HotLeadsTab` helper:

```tsx
async function HotLeadsTab({
  scope,
  detected,
  slug,
}: {
  scope: ReportScope;
  detected: DetectedFields;
  slug: string;
}) {
  const supabase = await createClient();
  return (
    <HotLeadsTable
      rows={await fetchHotLeadRows(supabase, scope, detected)}
      scopeSlug={slug}
    />
  );
}
```

- [ ] **Step 4: Verify** — `npx tsc --noEmit` (share still errors until Task 7); `npx eslint "src/app/(app)/reporting/page.tsx"` clean.
- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/reporting/page.tsx"
git commit -m "feat(reporting): admin hot-leads tab uses live warm calls"
```

---

## Task 7: Wire the public share

**Files:** Modify `src/app/share/reporting/[token]/page.tsx`

- [ ] **Step 1: Imports + gate**

Remove `hasInterestData` from the `report-data` import; add `isWarm` to the `field-detect` import. Replace the share's `showHotLeads` computation the same way:

```tsx
const showHotLeads =
  scope.kind === "campaign" &&
  detected.sentimentKey !== null &&
  detected.sentimentValues.some(isWarm);
```

- [ ] **Step 2: Hot Leads tab content**

Replace the hot-leads branch (`<HotLeadsTable rows={await fetchHotLeadRows(supabase)} … />`) with:

```tsx
<HotLeadsTable
  rows={await fetchHotLeadRows(supabase, scope, detected)}
  readOnly
  scopeSlug="campaign"
/>
```

- [ ] **Step 3: Verify (full)**
  - `npx tsc --noEmit` → only the 3 pre-existing `twilio-*.spec.ts` errors.
  - `npx eslint "src/app/(app)/reporting" "src/app/share/reporting" src/lib/agent-analytics src/lib/elevenlabs` → clean.
  - `npm run build` → success.
- [ ] **Step 4: Commit**

```bash
git add "src/app/share/reporting/[token]/page.tsx"
git commit -m "feat(reporting): public share hot-leads uses live warm calls (read-only)"
```

---

## Task 8: Playwright contract

**Files:** Modify `tests/reporting-scope.spec.ts`

- [ ] **Step 1: Extend the spec**

Reuse the existing sentiment-campaign seed (calls with `ai_call_answering_interest` yes/maybe/no + `ai_call_answering_reason` + a lead with `owner_name`/`list_id`). Assert:

- `/reporting?scope=campaign:<sentiment campaign>&tab=hot-leads` → the Hot Leads tab lists the **yes** and **maybe** calls (not the **no** call); headers include "Contact", "Why hot", "List"; there is **no** "Status" or "Owner" header; Company is a link to `/leads/<id>`.
- After inserting a row into `hot_lead_dismissals` for one of the warm calls (service client), reloading the tab no longer shows that company.
- A campaign with no warm sentiment → no "Hot Leads" tab link.

Use `page.getByRole("columnheader", { name: "Contact" })`, `page.getByRole("columnheader", { name: "Status" })` with `toHaveCount(0)`, and a `hot_lead_dismissals` insert/delete in the seed/cleanup. Match the file's existing seeding/cleanup shape; clean up any inserted dismissals in `afterAll`.

- [ ] **Step 2: Verify** — `npx tsc --noEmit` clean for the spec; `npx eslint tests/reporting-scope.spec.ts` clean. (Do not run Playwright.)
- [ ] **Step 3: Commit**

```bash
git add tests/reporting-scope.spec.ts
git commit -m "test(reporting): hot leads live list + dismissal"
```

---

## Task 9: Final verification (coordinator applies migration + opens PR)

- [ ] **Step 1: Full gates**

```bash
npx tsc --noEmit      # only the 3 pre-existing twilio-*.spec.ts errors
npx eslint "src/app/(app)/reporting" "src/app/share/reporting" src/lib/agent-analytics src/lib/elevenlabs
npm run build
```

- [ ] **Step 2: STOP — do not push.** Report to the coordinator. The coordinator will:
  1. Apply the migration to prod: `supabase db push --linked` (BEFORE deploy, per the migration-sequencing rule).
  2. `git push -u origin feat/reporting-phase3-hot-leads` + open the PR.
  3. Confirm with Marija before merging (auto-deploys).

PR body (for the coordinator):

> Phase 3 of the reporting redesign. Hot Leads is now a live per-campaign list of warm calls (yes+maybe / happy+mixed) — Date · Company (lead link) · Contact · Why hot · List — with a Delete that permanently hides a call (`hot_lead_dismissals` table). The old per-call seeder is retired. Hidden in the combined view; read-only on the public share. One additive migration (applied before deploy). Spec/plan in docs/superpowers.

---

## Self-review notes

- **Spec coverage:** live warm list (T2) ✓; dismissals table + delete (T1 migration, T3 action, T5 button) ✓; columns Date/Company(link)/Contact/Why-hot/List (T2 mapping, T5 table) ✓; removed status/owner/etc + status filter (T5 rewrite) ✓; visibility per-campaign + read-only share (T6, T7) ✓; 30-day window (T2 `VOICE_DAYS`) ✓; seeder retired + `hasInterestData` removed (T2, T4, T6, T7) ✓; migration applied before deploy (T9) ✓.
- **Type consistency:** `HotLeadRow {id, day, company, contact, whyHot, list, leadId}` produced by `fetchHotLeadRows(scope, detected)`, consumed by `HotLeadsTable`. `dismissHotLead({callId})` matches the table call. `hot_lead_dismissals` types match the migration columns. `showHotLeads` uses `isWarm` (imported in page + share). `reportingTabsFor({showVoice, showHotLeads})` unchanged from Phase 2.
- **Placeholder scan:** none.
- **Watch:** confirm `fmtLen` / `HotLeadRawRow` removal doesn't orphan other refs (only old Hot Leads used them); `leadCompany` stays (used by `fetchVoiceRows`). After Task 4, `grep -rn "agent-analytics/hot-leads" src/` must be empty.
