# Import Mobiles Into a Separate List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a CSV import route Twilio-confirmed mobile numbers into a separate lead list instead of dropping them, with a database-level lock so the AI can never auto-dial a number tagged "mobile."

**Architecture:** Add a nullable `line_type` column to `leads`, stamped at import. Route mobiles to a user-chosen second list (opt-in checkbox). Enforce "never dial mobiles" in the shared `pre_call_check` DB function (both the Autopilot cron and manual Call Now pass through it) and filter them out of the `dial_queue` view. Everything is additive and backward-compatible: existing leads have `line_type = null`, which reads as "not mobile" everywhere.

**Tech Stack:** Next.js 16 (App Router, Server Actions), Supabase/Postgres, TypeScript, Playwright (live-env contract tests).

---

## Testing reality for this repo (read first)

- **There is no CI and Playwright specs run against the LIVE environment** — you **cannot** run them locally. Treat the Playwright test in Task 8 as a written contract, not a locally-executed gate.
- **The local verification gate is:** `npx tsc --noEmit`, `npx eslint <changed files>`, and `npm run build`. Every code task ends by running these on the changed files.
- A pre-commit hook (husky + lint-staged) runs `eslint --fix` + `prettier` on staged files automatically. Expect it to reformat; that's fine.
- Work on branch `feat/import-mobiles-separate-list` (already created; the spec is already committed there).

## File structure (what changes and why)

- **Create** `supabase/migrations/20260713120000_lead_line_type_mobile_lock.sql` — the column + the two guard changes (`pre_call_check`, `dial_queue`).
- **Modify** `src/lib/supabase/database.types.ts` — hand-add `line_type` to the `leads` Row/Insert/Update (keeps local `tsc` green without a prod round-trip; reconciled by a real regen at deploy).
- **Modify** `src/lib/leads/import-fields.ts` — add `mobileImported` to `ImportResult`.
- **Modify** `src/lib/leads/import-actions.ts` — `analyzeImport` gains `splitMobiles`; `importLeads` gains `mobileListId`, routes mobiles, stamps `line_type`, counts `mobileImported`.
- **Modify** `src/lib/dialer/queue.ts` — add `"lead_is_mobile"` to the `PreCallReason` union.
- **Modify** `src/lib/dialer/call-now.ts` — friendly label for `lead_is_mobile`.
- **Modify** `src/app/(app)/leads/import/import-wizard.tsx` — checkbox, mobile-list picker, validation, thread params, updated review/done wording.
- **Modify** `tests/import.spec.ts` — add a contract test for the split.

Order matters: types (Task 2) before the code that uses them (Tasks 3–7). The prod migration apply is a **gated deploy step (Task 9)** done before merge.

---

### Task 1: Database migration

**Files:**

- Create: `supabase/migrations/20260713120000_lead_line_type_mobile_lock.sql`
- Reference (copy the CURRENT definitions from here): `supabase/migrations/20260705120000_weekend_callbacks.sql` — the `dial_queue` view (lines ~38–124) and the `pre_call_check` function (lines ~129 onward).

- [ ] **Step 1: Write the migration file**

Create `supabase/migrations/20260713120000_lead_line_type_mobile_lock.sql`. It has three parts: (a) the column, (b) `pre_call_check` re-declared with the mobile guard, (c) `dial_queue` re-declared with the mobile filter.

> **IMPORTANT for the implementer:** For parts (b) and (c) you must copy the **entire current body** of `pre_call_check` and `dial_queue` verbatim from `20260705120000_weekend_callbacks.sql` and insert only the marked lines. Do not paraphrase or shorten the bodies — a re-declared function/view replaces the whole thing, so any omission is a regression. The skeleton below shows exactly where the two new lines go.

```sql
-- Import mobiles into a separate list + hard "never auto-dial mobiles" lock.
--
-- 1) leads.line_type: Twilio Lookup classification captured at import. NULL for
--    every existing lead and for lookup-skipped imports, so nothing that exists
--    today changes behavior.
-- 2) pre_call_check: hard-block any lead tagged 'mobile' (covers BOTH the
--    Autopilot cron and manual Call Now — they share this gate).
-- 3) dial_queue: also filter mobiles out of the candidate list (defense-in-depth;
--    is-distinct-from keeps NULL = dialable).

alter table public.leads
  add column if not exists line_type text;

comment on column public.leads.line_type is
  'Twilio Lookup line-type at import (landline|mobile|voip|invalid|unknown). '
  'NULL for pre-feature or lookup-skipped leads. Leads tagged ''mobile'' are '
  'never auto-dialed (enforced in pre_call_check and dial_queue).';

-- ── pre_call_check ────────────────────────────────────────────────────────────
-- COPIED VERBATIM from 20260705120000_weekend_callbacks.sql, adding ONLY the
-- mobile guard immediately after the DNC check (marked NEW below).
create or replace function public.pre_call_check(
  in_lead_id uuid,
  in_campaign_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_lead public.leads%rowtype;
  v_campaign public.campaigns%rowtype;
  v_twilio public.twilio_numbers%rowtype;
  v_calls_last_hour integer;
  v_calls_last_day integer;
  v_active_calls integer;
  v_spend_today numeric;
  v_spend_month numeric;
  v_reserve_per_call constant numeric := 0.10;
begin
  select * into v_lead from public.leads where id = in_lead_id;
  if not found or v_lead.deleted_at is not null then
    return 'lead_missing_or_deleted';
  end if;
  if v_lead.business_phone is null then
    return 'lead_has_no_phone';
  end if;

  if exists (
    select 1 from public.dnc_entries where phone = v_lead.business_phone
  ) then
    return 'lead_on_dnc';
  end if;

  -- NEW: never auto-dial a mobile. Smile & Dial uses an AI (artificial) voice;
  -- auto-dialing cell phones is TCPA-restricted. NULL line_type is NOT blocked.
  if v_lead.line_type = 'mobile' then
    return 'lead_is_mobile';
  end if;

  -- ... COPY THE REST OF THE FUNCTION BODY VERBATIM from 20260705120000
  --     (call-in-flight check, campaign/twilio checks, calling hours, pacing,
  --     hourly/daily caps, concurrency, spend caps, final `return null;`) ...
end;
$$;

-- ── dial_queue ────────────────────────────────────────────────────────────────
-- COPIED VERBATIM from 20260705120000_weekend_callbacks.sql, adding ONLY the
-- marked line in the inner WHERE.
create or replace view public.dial_queue
with (security_invoker = true)
as
select distinct on (q.lead_id)
  -- ... COPY THE FULL SELECT LIST + FROM/JOIN VERBATIM from 20260705120000 ...
  q.dial_priority
from (
  select
    -- ... COPY THE FULL INNER SELECT + JOINS VERBATIM ...
  from public.leads l
  join public.campaigns c
    on c.owner_id = l.owner_id
    -- ... COPY THE FULL JOIN CONDITIONS VERBATIM ...
  where
    l.deleted_at is null
    and l.business_phone is not null
    and l.status in ('ready_to_call', 'callback')
    and (l.next_call_at is null or l.next_call_at <= now())
    and c.twilio_number_id is not null
    and l.line_type is distinct from 'mobile'  -- NEW: mobiles never queue
    -- ... COPY THE REMAINING WHERE CONDITIONS VERBATIM (DNC not-exists, etc.) ...
) q
order by q.lead_id, q.dial_priority, q.campaign_created_at, q.campaign_id;
```

- [ ] **Step 2: Sanity-check the SQL by eye**

Confirm: the column is `add column if not exists`; the `pre_call_check` body is complete and ends with its original `return null;` + `end; $$;`; the only additions are the two `-- NEW` lines; `dial_queue` keeps `distinct on (q.lead_id)` and the full `order by`. (You cannot run this locally — it is applied to prod in Task 9.)

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260713120000_lead_line_type_mobile_lock.sql
git commit -m "feat(db): add leads.line_type and hard-block mobiles from dialing"
```

---

### Task 2: Add `line_type` to the generated DB types

**Files:**

- Modify: `src/lib/supabase/database.types.ts` (the `leads` table block starts at line ~1543)

- [ ] **Step 1: Add `line_type` to the `leads` Row**

In `leads.Row`, add the line between `last_call_at: string | null;` and `list_id: string;`:

```ts
last_call_at: string | null;
line_type: string | null;
list_id: string;
```

- [ ] **Step 2: Add `line_type` to the `leads` Insert**

In `leads.Insert`, add between `last_call_at?: string | null;` and `list_id: string;`:

```ts
          last_call_at?: string | null;
          line_type?: string | null;
          list_id: string;
```

- [ ] **Step 3: Add `line_type` to the `leads` Update**

In `leads.Update`, add between `last_call_at?: string | null;` and `list_id?: string;`:

```ts
          last_call_at?: string | null;
          line_type?: string | null;
          list_id?: string;
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (no new errors).

- [ ] **Step 5: Commit**

```bash
git add src/lib/supabase/database.types.ts
git commit -m "chore(types): add leads.line_type to generated types"
```

---

### Task 3: Add `mobileImported` to `ImportResult`

**Files:**

- Modify: `src/lib/leads/import-fields.ts:28-38`

- [ ] **Step 1: Extend `ImportResult`**

Replace the `ImportResult` type with (adds `mobileImported`):

```ts
export type ImportResult = {
  imported: number;
  /** Leads that existed but had been deleted, brought back to life by this
   *  import (deleted_at cleared, fields refreshed, moved to the chosen list). */
  revived: number;
  updated: number;
  skipped: number;
  skippedMobile: number;
  skippedInvalid: number;
  /** Mobiles newly inserted/revived into the separate mobile list (only when the
   *  "split mobiles" option was on). Distinct from `skippedMobile`, which counts
   *  mobiles dropped because no mobile list was chosen. */
  mobileImported: number;
  error: string | null;
};
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: FAIL — `import-actions.ts` and `import-wizard.tsx` build `ImportResult` objects without `mobileImported`. That's expected; Tasks 4 and 7 add the field. (If you prefer a green tree per task, do Tasks 3+4+? together before committing; otherwise continue.)

- [ ] **Step 3: Commit**

```bash
git add src/lib/leads/import-fields.ts
git commit -m "feat(import): add mobileImported to ImportResult"
```

---

### Task 4: Route mobiles + stamp line_type in the import actions

**Files:**

- Modify: `src/lib/leads/import-actions.ts`

- [ ] **Step 1: Add `splitMobiles` to `analyzeImport` input**

Change the signature (around line 110):

```ts
export async function analyzeImport(input: {
  mapping: Record<string, string>;
  rows: Record<string, string>[];
  skipLookup?: boolean;
  splitMobiles?: boolean;
}): Promise<ImportAnalysis> {
```

- [ ] **Step 2: Don't file mobiles as "skipped" when splitting**

In the classification loop (around lines 195–208), replace the `mobile` branch:

```ts
    } else if (lineType === "mobile") {
      mobile++;
      skipped.push({ phone, reason: "Mobile number (TCPA compliance)" });
    } else if (lineType === "invalid") {
```

with:

```ts
    } else if (lineType === "mobile") {
      mobile++;
      // When splitting mobiles into their own list they're a destination, not an
      // error — keep them out of the skipped/error report. Still counted above.
      if (!input.splitMobiles) {
        skipped.push({ phone, reason: "Mobile number (TCPA compliance)" });
      }
    } else if (lineType === "invalid") {
```

(Leave `countImportDuplicates` untouched — it stays landline-only on purpose; see spec §3.)

- [ ] **Step 3: Add `mobileListId` to `importLeads` input + `mobileImported` to the base result**

Change the signature (around line 253) and `base` object (around line 260):

```ts
export async function importLeads(input: {
  listId: string;
  mobileListId?: string;
  dedup: "skip" | "update";
  mapping: Record<string, string>;
  rows: Record<string, string>[];
  rowLineTypes?: LineType[];
}): Promise<ImportResult> {
  const base = {
    imported: 0,
    revived: 0,
    updated: 0,
    skipped: 0,
    skippedMobile: 0,
    skippedInvalid: 0,
    mobileImported: 0,
  };
```

- [ ] **Step 4: Validate the mobile list**

Immediately after the existing `list` validation block (after line 279, the `if (!list) return ...` line), add:

```ts
if (input.mobileListId) {
  const { data: mobileList } = await supabase
    .from("lists")
    .select("id")
    .eq("id", input.mobileListId)
    .maybeSingle();
  if (!mobileList) {
    return { ...base, error: "Choose a valid list for mobile numbers." };
  }
}
```

- [ ] **Step 5: Widen the `updates` / `revives` accumulators**

Replace their declarations (around lines 396–406):

```ts
const updates: {
  leadId: string;
  fields: Record<string, unknown>;
  customs: { customId: string; value: string }[];
  lineType?: LineType;
}[] = [];
// Soft-deleted matches: bring them back rather than skip/insert.
const revives: {
  leadId: string;
  fields: Record<string, unknown>;
  customs: { customId: string; value: string }[];
  targetListId: string;
  lineType?: LineType;
}[] = [];
let skipped = 0;
let skippedMobile = 0;
let skippedInvalid = 0;
let mobileImported = 0;
```

- [ ] **Step 6: Route each row + stamp line_type**

Replace the top of the `input.rows.forEach((row, index) => {` loop — the mobile/invalid drop block (lines 411–421):

```ts
  input.rows.forEach((row, index) => {
    // Drop mobile and invalid numbers flagged by the Twilio Lookup analysis.
    const lineType = input.rowLineTypes?.[index];
    if (lineType === "mobile") {
      skippedMobile++;
      return;
    }
    if (lineType === "invalid") {
      skippedInvalid++;
      return;
    }
```

with:

```ts
  input.rows.forEach((row, index) => {
    const lineType = input.rowLineTypes?.[index];
    // Invalid/disconnected numbers are always dropped.
    if (lineType === "invalid") {
      skippedInvalid++;
      return;
    }
    const isMobile = lineType === "mobile";
    // A mobile with no mobile list to route into is dropped — preserves today's
    // behavior when the split option is off.
    if (isMobile && !input.mobileListId) {
      skippedMobile++;
      return;
    }
    // Mobiles go to the mobile list; everything else to the main list.
    const targetListId = isMobile ? input.mobileListId! : input.listId;
```

- [ ] **Step 7: Carry `targetListId` + `lineType` into insert/update/revive**

In the same loop, replace the `newLeads.push(...)` line (line 494):

```ts
newLeads.push({ ...fields, owner_id: user.id, list_id: input.listId });
```

with (new leads always store the classification):

```ts
newLeads.push({
  ...fields,
  owner_id: user.id,
  list_id: targetListId,
  line_type: lineType ?? null,
});
```

Replace the revive push (line 482):

```ts
revives.push({ leadId: match.id, fields, customs });
```

with:

```ts
revives.push({
  leadId: match.id,
  fields,
  customs,
  targetListId,
  lineType,
});
```

Replace the update push (line 489):

```ts
updates.push({ leadId: match.id, fields, customs });
```

with:

```ts
updates.push({ leadId: match.id, fields, customs, lineType });
```

- [ ] **Step 8: Count inserts per destination**

Replace the upsert `.select(...)` (line 518) — add `list_id`:

```ts
      .select("id, business_phone, list_id");
```

Replace `imported += inserted.length;` (line 527) with:

```ts
imported += inserted.filter((l) => l.list_id === input.listId).length;
if (input.mobileListId) {
  mobileImported += inserted.filter(
    (l) => l.list_id === input.mobileListId,
  ).length;
}
```

- [ ] **Step 9: Stamp line_type on updates without downgrading**

Replace the update apply (lines 576–581):

```ts
  for (const u of updates) {
    const { error } = await supabase
      .from("leads")
      .update(u.fields as LeadUpdate)
      .eq("id", u.leadId);
```

with (only stamp a _positive_ type, so a lookup-skipped re-import can't erase a `'mobile'` lock):

```ts
  for (const u of updates) {
    const stamp =
      u.lineType && u.lineType !== "unknown"
        ? { line_type: u.lineType }
        : {};
    const { error } = await supabase
      .from("leads")
      .update({ ...u.fields, ...stamp } as LeadUpdate)
      .eq("id", u.leadId);
```

- [ ] **Step 10: Revive into the right list + stamp**

Replace the revive apply (lines 597–605):

```ts
  for (const r of revives) {
    const { error } = await supabase
      .from("leads")
      .update({
        ...r.fields,
        deleted_at: null,
        list_id: input.listId,
      } as LeadUpdate)
      .eq("id", r.leadId);
```

with:

```ts
  for (const r of revives) {
    const stamp =
      r.lineType && r.lineType !== "unknown"
        ? { line_type: r.lineType }
        : {};
    const { error } = await supabase
      .from("leads")
      .update({
        ...r.fields,
        ...stamp,
        deleted_at: null,
        list_id: r.targetListId,
      } as LeadUpdate)
      .eq("id", r.leadId);
```

- [ ] **Step 11: Return `mobileImported`**

Update the failure-tail object (line 499) and the final success return (lines 621–629) to include `mobileImported`:

```ts
const failTail = {
  revived,
  skipped,
  skippedMobile,
  skippedInvalid,
  mobileImported,
};
```

```ts
return {
  imported,
  revived,
  updated,
  skipped,
  skippedMobile,
  skippedInvalid,
  mobileImported,
  error: null,
};
```

(Also check the mid-function error return near line 519–525 uses `...failTail` — it does, so it now carries `mobileImported`.)

- [ ] **Step 12: Lint (full typecheck comes at Task 6)**

Run: `npx eslint src/lib/leads/import-actions.ts src/lib/leads/import-fields.ts`
Expected: PASS (no errors).
Note: a full `npx tsc --noEmit` is still **expected to fail here** — the wizard's `runImport` accumulator (Task 6, Step 4b) doesn't yet include `mobileImported`. The tree goes green at the end of Task 6. `import-actions.ts` itself is complete and type-correct.

- [ ] **Step 13: Commit**

```bash
git add src/lib/leads/import-actions.ts
git commit -m "feat(import): route mobiles to a separate list and stamp line_type"
```

---

### Task 5: Type + label the new pre-call reason

**Files:**

- Modify: `src/lib/dialer/queue.ts:19-34`
- Modify: `src/lib/dialer/call-now.ts:27-46`

- [ ] **Step 1: Add the reason to the `PreCallReason` union**

In `queue.ts`, add `"lead_is_mobile"` (place it right after `"lead_on_dnc"` to mirror the DB order):

```ts
export type PreCallReason =
  | "lead_missing_or_deleted"
  | "lead_has_no_phone"
  | "lead_on_dnc"
  | "lead_is_mobile"
  | "call_in_flight"
  | "campaign_not_active"
  | "campaign_has_no_twilio_number"
  | "twilio_number_missing"
  | "twilio_number_reassigned"
  | "outside_calling_hours"
  | "pacing_wait"
  | "hourly_cap_hit"
  | "daily_cap_hit"
  | "concurrency_cap_hit"
  | "daily_spend_cap_hit"
  | "monthly_spend_cap_hit";
```

- [ ] **Step 2: Add the friendly Call-Now label**

In `call-now.ts`, add to `PRE_CALL_REASON_LABELS` (after the `lead_on_dnc` entry):

```ts
  lead_on_dnc: "This number is on the DNC list.",
  lead_is_mobile:
    "This is a mobile number — Smile & Dial doesn't auto-dial cell phones.",
```

- [ ] **Step 3: Lint (full typecheck comes at Task 6)**

Run: `npx eslint src/lib/dialer/queue.ts src/lib/dialer/call-now.ts`
Expected: PASS.
Note: these two files are independent of `ImportResult`, but a full `npx tsc --noEmit` is still expected to fail until Task 6 (the wizard's `ImportResult` accumulator). That's expected — proceed.

- [ ] **Step 4: Commit**

```bash
git add src/lib/dialer/queue.ts src/lib/dialer/call-now.ts
git commit -m "feat(dialer): recognize lead_is_mobile pre-call reason"
```

---

### Task 6: Wizard — checkbox, mobile-list picker, validation, threading

**Files:**

- Modify: `src/app/(app)/leads/import/import-wizard.tsx`

- [ ] **Step 1: Add state**

After `const [skipLookup, setSkipLookup] = useState(false);` (line 126), add:

```ts
const [splitMobiles, setSplitMobiles] = useState(false);
const [mobileListId, setMobileListId] = useState("");
const [createMobileListOpen, setCreateMobileListOpen] = useState(false);
```

After the `selectedListName` memo (lines 138–141), add:

```ts
const selectedMobileListName = useMemo(
  () => lists.find((l) => l.id === mobileListId)?.name ?? "",
  [lists, mobileListId],
);
```

- [ ] **Step 2: Add mobile-list handlers**

After `onListCreated` (lines 173–178), add:

```ts
function onMobileListPicked(value: string) {
  if (value === CREATE_LIST_SENTINEL) {
    setTimeout(() => setCreateMobileListOpen(true), 50);
    return;
  }
  setMobileListId(value);
}

function onMobileListCreated(id: string, name: string) {
  setLists((current) =>
    [...current, { id, name }].sort((a, b) => a.name.localeCompare(b.name)),
  );
  setMobileListId(id);
}
```

- [ ] **Step 3: Thread `splitMobiles` into analysis**

In `runAnalyze`, change the `analyzeImport` call (line 238–240):

```ts
res = await withRetry(() =>
  analyzeImport({ mapping, rows: chunk, skipLookup, splitMobiles }),
);
```

- [ ] **Step 4: Thread `mobileListId` into import**

In `runImport`, change the `importLeads` call (lines 301–308):

```ts
res = await withRetry(() =>
  importLeads({
    listId,
    mobileListId: splitMobiles ? mobileListId : undefined,
    dedup,
    mapping,
    rows: rows.slice(i, i + IMPORT_BATCH),
    rowLineTypes: lineTypes.slice(i, i + IMPORT_BATCH),
  }),
);
```

- [ ] **Step 4b: Include `mobileImported` in the `runImport` accumulator**

In `runImport`, add `mobileImported: 0,` to the `total` literal (the object typed `ImportResult`, ~lines 283–291):

```ts
const total: ImportResult = {
  imported: 0,
  revived: 0,
  updated: 0,
  skipped: 0,
  skippedMobile: 0,
  skippedInvalid: 0,
  mobileImported: 0,
  error: null,
};
```

And accumulate it alongside the others (after `total.skippedInvalid += res.skippedInvalid;`, ~line 325):

```ts
total.mobileImported += res.mobileImported;
```

- [ ] **Step 5: Pass new props to `ReviewStep` and `DoneStep`**

In the `done` branch (lines 370–380), add two props to `<DoneStep>`:

```tsx
<DoneStep
  result={result}
  listId={listId}
  listName={selectedListName}
  mobileListName={selectedMobileListName}
  hasActiveCampaign={activeCampaignListIds.includes(listId)}
  onReset={resetWizard}
/>
```

In the `summary` branch (lines 390–400), add two props to `<ReviewStep>`:

```tsx
<ReviewStep
  analysis={analysis}
  fileName={fileName}
  skippedLookup={skipLookup}
  splitMobiles={splitMobiles}
  mobileListName={selectedMobileListName}
  dedup={dedup}
  pending={pending}
  progress={progress}
  onBack={() => setStep("map")}
  onImport={runImport}
  onDownloadErrors={downloadErrorReport}
/>
```

- [ ] **Step 6: Validation for the upload step**

Replace the `canContinue` / `blockedReason` block (lines 440–445):

```ts
const hasLists = lists.length > 0;
const canContinue = Boolean(parsed && listId);
const blockedReason = !parsed
  ? "Drop a CSV above to continue."
  : !listId
    ? "Pick a list to continue."
    : "";
```

with:

```ts
const hasLists = lists.length > 0;
const mobileListInvalid =
  splitMobiles && (!mobileListId || mobileListId === listId);
const canContinue = Boolean(parsed && listId) && !mobileListInvalid;
const blockedReason = !parsed
  ? "Drop a CSV above to continue."
  : !listId
    ? "Pick a list to continue."
    : splitMobiles && !mobileListId
      ? "Pick a list for mobile numbers."
      : splitMobiles && mobileListId === listId
        ? "The mobile list must be different from the main list."
        : "";
```

- [ ] **Step 7: Make skip-lookup and split mutually exclusive**

Replace the skip-lookup `<Checkbox>` (lines 566–570) so turning skip on clears the split:

```tsx
<Checkbox
  id="skip-lookup"
  checked={skipLookup}
  disabled={splitMobiles}
  onCheckedChange={(value) => {
    const on = value === true;
    setSkipLookup(on);
    if (on) setSplitMobiles(false);
  }}
  className="mt-0.5"
/>
```

- [ ] **Step 8: Add the split-mobiles checkbox + mobile-list picker**

Immediately after the closing `</div>` of the skip-lookup block (after line 586, before the `<div className="flex flex-wrap items-center justify-between gap-3 pt-1">` actions row), insert:

```tsx
{
  /* Split mobiles into a separate, never-auto-dialed list. Requires the
            Twilio lookup (mutually exclusive with "Skip verification"): without
            it we can't tell which numbers are mobile. */
}
<div className="border-border bg-muted/20 flex flex-col gap-3 rounded-xl border px-4 py-3">
  <div className="flex items-start gap-3">
    <Checkbox
      id="split-mobiles"
      checked={splitMobiles}
      disabled={skipLookup}
      onCheckedChange={(value) => {
        const on = value === true;
        setSplitMobiles(on);
        if (on) setSkipLookup(false);
        if (!on) setMobileListId("");
      }}
      className="mt-0.5"
    />
    <div className="flex flex-col gap-0.5">
      <Label
        htmlFor="split-mobiles"
        className="cursor-pointer text-sm font-medium"
      >
        Also import mobile numbers into a separate list
      </Label>
      <p className="text-muted-foreground text-xs">
        Mobiles are kept in their own list and are never auto-dialed (call or
        text them manually). Landlines still go to your main list above.
        {skipLookup
          ? " Turn off “Skip Twilio number verification” to use this."
          : ""}
      </p>
    </div>
  </div>

  {splitMobiles ? (
    <div className="flex flex-col gap-2 pl-7">
      <Label htmlFor="mobile-list">Put mobile numbers in</Label>
      <Select value={mobileListId} onValueChange={onMobileListPicked}>
        <SelectTrigger id="mobile-list">
          <SelectValue placeholder="Choose a list for mobiles" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>Your lists</SelectLabel>
            {lists
              .filter((list) => list.id !== listId)
              .map((list) => (
                <SelectItem key={list.id} value={list.id}>
                  {list.name}
                </SelectItem>
              ))}
          </SelectGroup>
          <SelectSeparator />
          <SelectItem value={CREATE_LIST_SENTINEL}>
            + Create a new list…
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
  ) : null}
</div>;
```

- [ ] **Step 9: Add the second create-list dialog**

Just before the closing `</div>` that wraps the upload view, after the existing `<CreateListInlineDialog ... onCreated={onListCreated} />` (lines 599–603), add a second instance:

```tsx
<CreateListInlineDialog
  open={createMobileListOpen}
  onOpenChange={setCreateMobileListOpen}
  onCreated={onMobileListCreated}
/>
```

- [ ] **Step 10: Update `ReviewStep` signature + mobile stat**

In `ReviewStep`'s props (lines 785–805), add `splitMobiles` and `mobileListName`:

```tsx
function ReviewStep({
  analysis,
  fileName,
  skippedLookup,
  splitMobiles,
  mobileListName,
  dedup,
  pending,
  progress,
  onBack,
  onImport,
  onDownloadErrors,
}: {
  analysis: ImportAnalysis;
  fileName: string;
  skippedLookup: boolean;
  splitMobiles: boolean;
  mobileListName: string;
  dedup: "skip" | "update";
  pending: boolean;
  progress: { done: number; total: number } | null;
  onBack: () => void;
  onImport: () => void;
  onDownloadErrors: () => void;
}) {
```

Replace the derived-counts block (lines 806–819) so mobiles-to-route count as work to do:

```ts
const dupExisting = analysis.duplicateExisting;
const dupInFile = analysis.duplicateInFile;
const newCount = Math.max(0, analysis.importable - dupExisting - dupInFile);
const hasDuplicates = dupExisting > 0 || dupInFile > 0;
// Mobiles routed to the separate list (only when splitting). analysis.mobile
// may include a few duplicates, but it's the honest "will be handled" count.
const mobileToImport = splitMobiles ? analysis.mobile : 0;
// "Every row skipped" only if there's genuinely nothing to do — no landlines
// AND no mobiles to route.
const noImportable = analysis.importable === 0 && mobileToImport === 0;
const willUpdateExisting = dedup === "update" && dupExisting > 0;
const nothingToDo =
  newCount === 0 && !willUpdateExisting && mobileToImport === 0;
```

Replace the mobile `<ReviewStat>` (lines 855–861) so it names the destination when splitting:

```tsx
<ReviewStat
  icon={<Smartphone className="size-3.5" />}
  tone="muted"
  label={
    splitMobiles
      ? `Mobile numbers → ${mobileListName}`
      : "Mobile numbers (skipped)"
  }
  value={analysis.mobile}
  tooltip={
    splitMobiles
      ? "Kept in the separate mobile list. Never auto-dialed."
      : "Mobile lines can't be auto-dialed safely. Smile & Dial only calls landlines."
  }
/>
```

- [ ] **Step 11: Update the Import button label**

Replace the primary button label expression (lines 962–968) so it reflects a mobile-only import:

```tsx
{
  pending
    ? progress
      ? `Importing ${progress.done.toLocaleString()} / ${progress.total.toLocaleString()}…`
      : "Importing…"
    : newCount > 0
      ? `Import ${plural(newCount, "lead")}`
      : mobileToImport > 0
        ? `Import ${plural(mobileToImport, "mobile")}`
        : willUpdateExisting
          ? `Update ${plural(dupExisting, "lead")}`
          : `Import ${plural(newCount, "lead")}`;
}
```

- [ ] **Step 12: Update `DoneStep` signature + destinations line**

In `DoneStep`'s props (lines 1011–1026), add `mobileListName`:

```tsx
function DoneStep({
  result,
  listId,
  listName,
  mobileListName,
  hasActiveCampaign,
  onReset,
}: {
  result: ImportResult;
  listId: string;
  listName: string;
  mobileListName: string;
  hasActiveCampaign: boolean;
  onReset: () => void;
}) {
```

Replace the `totalAdded` + `detailParts` block (lines 1028–1037) so mobiles count and are attributed:

```ts
// Newly-present leads = fresh inserts + revived + mobiles routed to their list.
const totalAdded = result.imported + result.revived + result.mobileImported;
const detailParts: string[] = [];
if (result.mobileImported > 0)
  detailParts.push(`${result.mobileImported} mobile into “${mobileListName}”`);
if (result.revived > 0) detailParts.push(`${result.revived} restored`);
if (result.updated > 0) detailParts.push(`${result.updated} updated`);
if (result.skipped > 0)
  detailParts.push(`${plural(result.skipped, "duplicate")} skipped`);
if (result.skippedMobile > 0)
  detailParts.push(`${result.skippedMobile} mobile skipped`);
if (result.skippedInvalid > 0)
  detailParts.push(`${result.skippedInvalid} invalid skipped`);
```

Replace the headline's list suffix (lines 1069–1074) so it only names the single list when there was no mobile split:

```tsx
{
  listName && result.mobileImported === 0 ? (
    <span className="text-foreground/70 font-normal">
      {" "}
      into &ldquo;{listName}&rdquo;
    </span>
  ) : null;
}
```

- [ ] **Step 13: Typecheck, lint, build**

Run: `npx tsc --noEmit`
Expected: PASS.
Run: `npx eslint "src/app/(app)/leads/import/import-wizard.tsx"`
Expected: PASS.
Run: `npm run build`
Expected: build completes with no type/lint errors.

- [ ] **Step 14: Commit**

```bash
git add "src/app/(app)/leads/import/import-wizard.tsx"
git commit -m "feat(import): wizard UI to split mobiles into a separate list"
```

---

### Task 7: Verify the full local gate

**Files:** none (verification only)

- [ ] **Step 1: Run the whole gate on the branch**

Run: `npx tsc --noEmit`
Expected: PASS.
Run: `npx eslint src/lib/leads/import-actions.ts src/lib/leads/import-fields.ts src/lib/dialer/queue.ts src/lib/dialer/call-now.ts "src/app/(app)/leads/import/import-wizard.tsx"`
Expected: PASS.
Run: `npm run build`
Expected: PASS.

If anything fails, fix before continuing. No commit (nothing changed) unless a fix was needed.

---

### Task 8: Playwright contract test (cannot run locally)

**Files:**

- Modify: `tests/import.spec.ts`

- [ ] **Step 1: Add a second list in setup**

In `beforeAll`, after `listId = list!.id;` (line 31), create a mobile list and store the owner id for later assertions:

```ts
ownerId = owner!.id;
const { data: mobileList } = await admin
  .from("lists")
  .insert({ owner_id: owner!.id, name: `E2E Mobile List ${stamp}` })
  .select("id")
  .single();
mobileListId = mobileList!.id;
```

Add the module-scope declarations next to `let listId: string;` (line 13):

```ts
let ownerId: string;
let mobileListId: string;
```

In `afterAll` (lines 34–37), also clean up the mobile list:

```ts
test.afterAll(async () => {
  await admin.from("leads").delete().eq("list_id", listId);
  await admin.from("leads").delete().eq("list_id", mobileListId);
  await admin.from("lists").delete().eq("id", listId);
  await admin.from("lists").delete().eq("id", mobileListId);
});
```

- [ ] **Step 2: Add the split test**

Append this test inside the `describe` block (after the existing test, before the closing `});` on line 105):

```ts
test("splitting mobiles routes them to the mobile list and locks dialing", async ({
  page,
}) => {
  const landline = `E2E Split Landline ${stamp}`;
  const mobile = `E2E Split Mobile ${stamp}`;
  // +1700… → mobile in the mock lookup; the rest are landlines.
  const csv =
    "company,business_phone,city,state\n" +
    `${landline},+1512${tail}6,Austin,TX\n` +
    `${mobile},+1700${tail}7,Austin,TX\n`;

  await page.goto("/leads/import");
  await page.getByLabel("CSV file").setInputFiles({
    name: "split.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv),
  });

  await page.getByLabel("Import into list").click();
  await page.getByRole("option", { name: `E2E Import List ${stamp}` }).click();

  // Turn on the split and pick the mobile list.
  await page
    .getByLabel("Also import mobile numbers into a separate list")
    .check();
  await page.getByLabel("Put mobile numbers in").click();
  await page.getByRole("option", { name: `E2E Mobile List ${stamp}` }).click();

  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Review import" }).click();

  // The mobile is now a destination, not a skipped error.
  await expect(
    page.getByText(new RegExp(`Mobile numbers → E2E Mobile List ${stamp}`)),
  ).toBeVisible();

  await page.getByRole("button", { name: /Import 1 lead/ }).click();
  await expect(
    page.getByRole("heading", { name: /leads imported/i }),
  ).toBeVisible();

  // DB assertions: the mobile landed in the mobile list, tagged 'mobile'.
  const { data: mobileLead } = await admin
    .from("leads")
    .select("list_id, line_type")
    .eq("owner_id", ownerId)
    .eq("company", mobile)
    .single();
  expect(mobileLead?.list_id).toBe(mobileListId);
  expect(mobileLead?.line_type).toBe("mobile");

  // The landline went to the main list.
  const { data: landlineLead } = await admin
    .from("leads")
    .select("list_id")
    .eq("owner_id", ownerId)
    .eq("company", landline)
    .single();
  expect(landlineLead?.list_id).toBe(listId);
});
```

- [ ] **Step 3: Typecheck + lint the test**

Run: `npx tsc --noEmit`
Expected: PASS.
Run: `npx eslint tests/import.spec.ts`
Expected: PASS.

(Do **not** try to run `npm test` — it hits the live environment and isn't available here.)

- [ ] **Step 4: Commit**

```bash
git add tests/import.spec.ts
git commit -m "test(import): contract for splitting mobiles into a separate list"
```

---

### Task 9: Deploy sequence (GATED — hits production)

**Files:** none (operational)

> **CHECKPOINT — confirm with Marija before this task.** Applying the migration writes to the LIVE production database. It is additive and safe (a nullable column + two null-safe guard changes), but it is still a production change and must be done **before** the code merges so the code that writes `line_type` has a column to write to.

- [ ] **Step 1: Apply the migration to prod**

Run: `supabase db push --linked`
Expected: applies `20260713120000_lead_line_type_mobile_lock.sql`; reports success.

- [ ] **Step 2: Regenerate types to reconcile the hand-edit**

Regenerate `src/lib/supabase/database.types.ts` from the linked project (the repo's usual method). If it differs from the Task 2 hand-edit, commit the reconciled file:

```bash
git add src/lib/supabase/database.types.ts
git commit -m "chore(types): regenerate after line_type migration"
```

If there's no diff, skip the commit.

- [ ] **Step 3: Push the branch and open the PR**

```bash
git push -u origin feat/import-mobiles-separate-list
```

Open a PR to `main` with a description covering: the opt-in split, the hard mobile lock (pre_call_check + dial_queue), backward-compatibility, and the manual-verification checklist below. Merge → Vercel auto-deploys.

---

## Post-merge manual verification (live)

Since Playwright can't run here, sanity-check in the deployed app:

1. Import a small CSV with a known landline and a known mobile, split **on**, mobile list chosen → confirm the landline is in the main list and the mobile is in the mobile list.
2. Attach an active campaign to the mobile list, then try **Call Now** on a mobile lead → confirm it's refused with "This is a mobile number — Smile & Dial doesn't auto-dial cell phones," and Autopilot never dials it.
3. Import with split **off** → mobiles are dropped exactly as before (regression check).

---

## Self-review notes (author)

- **Spec coverage:** routing table → Tasks 4/6; hard lock → Task 1 (+5 for typing); stored line type → Tasks 1/2/4; opt-in + mutual exclusivity + validation → Task 6; honest counts/wording → Task 6; contract test → Task 8; migration safety/sequencing → Task 9.
- **Type consistency:** `mobileImported` (import-fields → import-actions → wizard), `splitMobiles` (wizard → analyzeImport), `mobileListId` (wizard → importLeads), `mobileListName` (wizard → Review/Done), `"lead_is_mobile"` (DB → queue.ts → call-now.ts) all line up.
- **Known non-blocking approximation:** the Review step's mobile count (`analysis.mobile`) may include a few duplicates that de-dup at commit; the Done step then shows the exact `mobileImported`. Acceptable.
