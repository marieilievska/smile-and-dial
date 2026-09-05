# Cohort Reporting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attribute every registration, attendance and sale back to the dial day whose spend produced it, so cost per registration / attended / sale can be read honestly instead of by dividing one day's cost by another day's outcomes.

**Architecture:** A registration (`calendly_events` row) becomes the unit that owns its outcome, carrying a stored `dial_day` that survives reschedules. Aggregation happens in one `SECURITY INVOKER` SQL function so PostgREST's 1000-row cap can't undercount and RLS scopes members to their own leads. Marking stays in the Goals pipeline, which writes through to the registration.

**Tech Stack:** Next.js (App Router, Server Components), Supabase/PostgreSQL with RLS, TypeScript, Vitest (`tests/*.unit.test.ts`), Node `.mjs` scripts for one-off data operations.

**Spec:** `docs/superpowers/specs/2026-09-05-cohort-reporting-design.md`

---

## File Structure

**Phase 1 — wipe safety (must land before the Monday wipe)**

- Modify: `scripts/backup-before-wipe.mjs` — add the two unbacked tables
- Modify: `scripts/wipe-data.mjs` — clear the two uncleared tables
- Create: `scripts/dump-inflight-registrations.mjs` — CSV of people with a future session

**Phase 2 — data model**

- Create: `supabase/migrations/20260905120000_cohort_columns.sql`
- Modify: `src/lib/supabase/database.types.ts` (regenerated, never hand-edited)
- Modify: `src/lib/elevenlabs/tool-webhook.ts:1339` — stamp `dial_day`

**Phase 3 — marking**

- Create: `src/lib/goals/pick-registration.ts` — pure: which registration a mark applies to
- Create: `tests/cohort-pick-registration.unit.test.ts`
- Modify: `src/lib/goals/goal-statuses.ts` — add `rescheduled`
- Modify: `src/lib/goals/pipeline-actions.ts` — write through to the registration
- Create: `src/lib/goals/reschedule-actions.ts` — the session-picker action
- Modify: `src/app/(app)/goals/pipeline-board.tsx` — the Rescheduled column
- Create: `src/app/(app)/goals/reschedule-dialog.tsx`

**Phase 4 — the report**

- Create: `supabase/migrations/20260905130000_cohort_rows_fn.sql`
- Create: `src/lib/cohorts/math.ts` — pure: rates, projection, ripeness
- Create: `tests/cohort-math.unit.test.ts`
- Create: `src/lib/cohorts/data.ts` — calls the SQL function
- Create: `src/app/(app)/reporting/cohorts-view.tsx`
- Modify: `src/app/(app)/reporting/reporting-tabs.tsx` — add Cohorts, remove VoC/Hot Leads, filter by role
- Modify: `src/app/(app)/reporting/page.tsx` — drop the admin gate, wire the tab
- Delete: `src/app/(app)/reporting/voice-table.tsx`, `src/app/(app)/reporting/hot-leads-table.tsx`

---

## Phase 1 — Wipe safety

**Why first:** `wipe-data.mjs` clears neither `calendly_events` nor `cost_rollup_daily`, and `backup-before-wipe.mjs` backs up neither. As things stand, Monday's wipe deletes all 21 registrations with no copy anywhere and leaves 9/2–9/4 spend rows behind as zombies. This phase is independent of the rest and ships on its own.

### Task 1.1: Back up the two missing tables

**Files:**

- Modify: `scripts/backup-before-wipe.mjs:29-42`

- [ ] **Step 1: Add both tables to the backup list**

The `TABLES` array drives the dump. Add the two tables the wipe touches (or will touch) but that are absent today:

```javascript
// Every table the wipe will delete from (plus the kept ledgers, for safety).
const TABLES = [
  "leads",
  "lead_custom_values",
  "calls",
  "callbacks",
  "campaigns",
  "calendly_events",
  "cost_rollup_daily",
  "dnc_entries",
  "dnc_removals",
  "system_events",
  "emails",
  "goals",
  "lookup_charges",
  "lists",
];
```

- [ ] **Step 2: Run the backup and confirm both files appear**

Run: `node scripts/backup-before-wipe.mjs`

Expected: the run prints a line per table and creates `backups/wipe-<stamp>/calendly_events.json` and `backups/wipe-<stamp>/cost_rollup_daily.json`. `calendly_events.json` must contain 21 rows today. This script is read-only — it touches nothing in the database.

- [ ] **Step 3: Verify the registration backup is complete, not truncated**

Run: `node -e "const r=require('./backups/<stamp>/calendly_events.json'); console.log(r.length, r[0].invitee_email, r[0].scheduled_at)"`

Expected: `21` and a real email and timestamp. `fetchAll()` in that script already pages at 1000, so no row cap applies.

- [ ] **Step 4: Commit**

```bash
git add scripts/backup-before-wipe.mjs
git commit -m "fix(wipe): back up calendly_events and cost_rollup_daily before a wipe"
```

### Task 1.2: Dump the in-flight registrations to CSV

**Files:**

- Create: `scripts/dump-inflight-registrations.mjs`

**Context:** 12 registrations have a session still in the future (8 for Monday 2 PM, 2 each for 9/9 and 9/10). The operator chose a clean slate, so these are being let go — but a CSV means a sale from one of them can still be reconciled by hand.

- [ ] **Step 1: Write the script**

```javascript
// READ-ONLY. Dumps registrations whose session is still in the future to a CSV
// in backups/, so people lost to a wipe can be reconciled by hand afterwards.
// Run: node scripts/dump-inflight-registrations.mjs
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const env = {};
for (const line of readFileSync(join(ROOT, ".env.local"), "utf8").split(
  /\r?\n/,
)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m) env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, "");
}
const admin = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const { data: events, error } = await admin
  .from("calendly_events")
  .select(
    "lead_id, invitee_name, invitee_email, invitee_phone, scheduled_at, created_at, status",
  )
  .order("scheduled_at", { ascending: true });
if (error) throw new Error(error.message);

const now = Date.now();
const inflight = (events ?? []).filter(
  (e) =>
    e.status !== "canceled" &&
    e.scheduled_at &&
    new Date(e.scheduled_at).getTime() > now,
);

// Company name lives on the lead, which the wipe deletes — copy it in now.
const leadIds = [...new Set(inflight.map((e) => e.lead_id).filter(Boolean))];
const companies = new Map();
for (let i = 0; i < leadIds.length; i += 100) {
  const { data } = await admin
    .from("leads")
    .select("id, company")
    .in("id", leadIds.slice(i, i + 100));
  for (const l of data ?? []) companies.set(l.id, l.company);
}

const etDay = (iso) =>
  new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const etStamp = (iso) =>
  new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York" });
const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

const header = [
  "company",
  "name",
  "email",
  "phone",
  "dial_day_et",
  "session_et",
];
const lines = [header.join(",")];
for (const e of inflight) {
  lines.push(
    [
      companies.get(e.lead_id),
      e.invitee_name,
      e.invitee_email,
      e.invitee_phone,
      etDay(e.created_at),
      etStamp(e.scheduled_at),
    ]
      .map(csvCell)
      .join(","),
  );
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(ROOT, "backups");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `inflight-registrations-${stamp}.csv`);
writeFileSync(outPath, lines.join("\n"), "utf8");
console.log(`Wrote ${inflight.length} in-flight registrations to ${outPath}`);
```

- [ ] **Step 2: Run it and verify the count**

Run: `node scripts/dump-inflight-registrations.mjs`

Expected: `Wrote 12 in-flight registrations to .../backups/inflight-registrations-<stamp>.csv`

If the count is not 12, do not proceed — re-check whether a session has passed since this plan was written (sessions on 9/8, 9/9 and 9/10 are the ones counted).

- [ ] **Step 3: Eyeball the CSV**

Run: `cat backups/inflight-registrations-*.csv`

Expected: 13 lines (header + 12), each with a real company, email and a session timestamp in September. Company must be populated — that is the field the wipe destroys.

- [ ] **Step 4: Commit**

```bash
git add scripts/dump-inflight-registrations.mjs
git commit -m "feat(wipe): dump in-flight registrations to CSV before a wipe"
```

### Task 1.3: Clear both tables in the wipe

**Files:**

- Modify: `scripts/wipe-data.mjs:33-58` (helpers), `:40-52` (report list), `:84-95` (deletes)

**Critical gotcha:** `count()` and `deleteAll()` both key off an `id` column. `cost_rollup_daily` **has no `id`** — its primary key is `(et_day, campaign_id, list_id, owner_id)`. Calling either against it as written fails. Both helpers must take a key column.

- [ ] **Step 1: Make the helpers take a key column**

Replace the two helpers:

```javascript
async function count(table, key = "id") {
  const { count } = await admin
    .from(table)
    .select(key, { count: "exact", head: true });
  return count ?? 0;
}
async function report(label) {
  const tables = [
    ["leads"],
    ["calls"],
    ["callbacks"],
    ["campaigns"],
    ["calendly_events"],
    ["cost_rollup_daily", "et_day"],
    ["dnc_entries"],
    ["system_events"],
    ["goals"],
    ["lookup_charges"],
    ["lists"],
  ];
  console.log(`\n=== ${label} ===`);
  for (const [t, key] of tables)
    console.log(`  ${t.padEnd(20)} ${await count(t, key)}`);
}

async function deleteAll(table, key = "id") {
  // A real WHERE clause is required; the key is a NOT NULL PK column so this
  // matches all rows. cost_rollup_daily has no `id` — its PK is composite.
  const { error } = await admin.from(table).delete().not(key, "is", null);
  if (error) throw new Error(`delete ${table}: ${error.message}`);
}
```

- [ ] **Step 2: Add the two deletions in FK-safe order**

`calendly_events.lead_id` is `on delete set null`, so leads could go first without an error — but deleting registrations _before_ leads keeps the order honest about what depends on what. `cost_rollup_daily` has no foreign keys and goes last.

```javascript
await deleteAll("calls");
console.log("Deleted calls");
await deleteAll("callbacks");
console.log("Deleted callbacks");
await deleteAll("calendly_events");
console.log("Deleted calendly events (registrations)");
await deleteAll("leads");
console.log("Deleted leads (custom values/emails cascade)");
await deleteAll("campaigns");
console.log("Deleted campaigns (Twilio numbers released)");
await deleteAll("dnc_entries");
console.log("Deleted DNC entries");
await deleteAll("system_events");
console.log("Deleted system events");
await deleteAll("cost_rollup_daily", "et_day");
console.log("Deleted cost rollup (pre-wipe spend rows)");
```

- [ ] **Step 3: Update the header comment to match**

The comment block at the top lists the delete order and what is kept. It is now wrong. Replace lines 6-11:

```javascript
// Deletes, in FK-safe order: call recordings (Storage) -> calls -> callbacks
// -> calendly_events -> leads (cascades custom values/emails) -> campaigns
// (releases Twilio numbers) -> the DNC entry -> system_events ->
// cost_rollup_daily.
// KEEPS: lookup_charges, goals (definitions), lists, agents, twilio_numbers,
// dnc_removals, and ElevenLabs (untouched).
```

- [ ] **Step 4: Dry run and confirm the new tables are counted**

Run: `node scripts/wipe-data.mjs`

Expected: the BEFORE report lists `calendly_events 21` and `cost_rollup_daily 6`, then `Dry run only. Re-run with --yes to perform the deletion.` **Nothing is deleted.** If `cost_rollup_daily` errors instead of printing a count, the key-column change in Step 1 is wrong.

- [ ] **Step 5: Commit**

```bash
git add scripts/wipe-data.mjs
git commit -m "fix(wipe): clear calendly_events and cost_rollup_daily so a wipe is actually clean"
```

### Task 1.4: Open the PR for Phase 1

- [ ] **Step 1: Push and open**

```bash
git push -u origin feat/cohort-reporting
gh pr create --title "fix(wipe): make a data wipe actually clean, and back up what it destroys" --body "$(cat <<'BODY'
`wipe-data.mjs` clears neither `calendly_events` nor `cost_rollup_daily`, and
`backup-before-wipe.mjs` backs up neither. Before this, a wipe deleted every
registration with no copy anywhere and left old spend rows behind as zombies —
days carrying cost and registrations with no calls and no outcomes.

- back up both tables before a wipe
- clear both during a wipe (`cost_rollup_daily` has no `id` column, so the
  helpers now take a key column — calling them as written failed)
- new `dump-inflight-registrations.mjs` writes a CSV of anyone whose session is
  still in the future, copying the company name off the lead before it is
  deleted

Verified by dry run: BEFORE reports `calendly_events 21`, `cost_rollup_daily 6`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```

---

## Phase 2 — Data model

### Task 2.1: Migration for the registration columns and the new status

**Files:**

- Create: `supabase/migrations/20260905120000_cohort_columns.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Cohort reporting: a registration owns its own outcome, and carries the dial
-- day whose spend produced it.
--
-- dial_day is STORED, not derived from created_at: a rescheduled booking is
-- created on the day of the reschedule, so deriving the cohort would silently
-- move a person from the day that paid for them to a day that did not.

alter table public.calendly_events
  add column if not exists dial_day date,
  add column if not exists attended_at timestamptz,
  add column if not exists sale_at timestamptz,
  add column if not exists rescheduled_at timestamptz;

comment on column public.calendly_events.dial_day is
  'ET day of the call that produced this booking. Preserved across a '
  'reschedule so the cohort stays with the spend that bought it.';

create index if not exists calendly_events_dial_day_idx
  on public.calendly_events (dial_day);

-- Backfill: every existing registration was booked during its own call, so the
-- creation day IS the dial day. Only true for rows predating this migration.
update public.calendly_events
set dial_day = (created_at at time zone 'America/New_York')::date
where dial_day is null;

-- The goal pipeline gains 'rescheduled'. The constraint lists every allowed
-- status, so the value must be added here or the write is rejected.
alter table public.leads
  drop constraint if exists leads_status_check;

alter table public.leads
  add constraint leads_status_check check (
    status in (
      'ready_to_call', 'callback', 'resting', 'goal_met', 'scheduled',
      'attended', 'no_show', 'rescheduled', 'closed', 'sale', 'dnc',
      'email_replied'
    )
  );
```

- [ ] **Step 2: Apply it**

Run: `npx supabase db push --linked`

Expected: the migration applies without error. This hits the **live production database** — there is no separate test database.

- [ ] **Step 3: Verify the backfill covered every row**

Run:

```bash
node -e "
const {createClient}=require('@supabase/supabase-js');
const fs=require('fs');const env={};
for(const l of fs.readFileSync('.env.local','utf8').split(/\r?\n/)){const m=/^\s*([A-Z0-9_]+)\s*=\s*(.*)\$/.exec(l);if(m)env[m[1]]=m[2].trim().replace(/^['\"]|['\"]\$/g,'');}
const a=createClient(env.NEXT_PUBLIC_SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY);
a.from('calendly_events').select('dial_day,created_at').then(({data})=>{
  console.log('rows',data.length,'null dial_day',data.filter(r=>!r.dial_day).length);
});
"
```

Expected: `rows 21 null dial_day 0`

- [ ] **Step 4: Regenerate the database types**

Run: `env -u SUPABASE_ACCESS_TOKEN npx supabase gen types typescript --linked --schema public > src/lib/supabase/database.types.ts`

The `env -u` is required: the plugin's stored access token belongs to the wrong organisation and shadows the good login, producing `Unauthorized`. **Never hand-edit this file.**

- [ ] **Step 5: Confirm the types compile**

Run: `npx tsc --noEmit`

Expected: no errors. `dial_day`, `attended_at`, `sale_at` and `rescheduled_at` now appear on the `calendly_events` Row/Insert/Update types.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260905120000_cohort_columns.sql src/lib/supabase/database.types.ts
git commit -m "feat(cohorts): registrations carry their dial day and their own outcome"
```

### Task 2.2: Stamp `dial_day` when a booking is made

**Files:**

- Modify: `src/lib/elevenlabs/tool-webhook.ts:1339-1350`

- [ ] **Step 1: Add the import**

At the top of the file, alongside the other `@/lib` imports:

```typescript
import { etDayString } from "@/lib/time/eastern";
```

- [ ] **Step 2: Stamp the column on insert**

The booking insert becomes:

```typescript
if (result.inviteeUri) {
  await ctx.supabase.from("calendly_events").insert({
    owner_id: ctx.lead.owner_id,
    lead_id: ctx.lead.id,
    invitee_uri: result.inviteeUri,
    event_uri: result.eventUri ?? "",
    event_type_uri: cal.eventTypeUri,
    invitee_email: email,
    invitee_name: name || null,
    scheduled_at: when.toISOString(),
    status: "scheduled",
    // The booking happens DURING the call, so today's ET day is the dial day
    // whose spend produced it. Stored rather than derived because a later
    // reschedule would otherwise re-date the cohort (see the design doc).
    dial_day: etDayString(),
  });
}
```

- [ ] **Step 3: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint src/lib/elevenlabs/tool-webhook.ts`

Expected: both clean.

- [ ] **Step 4: Commit**

```bash
git add src/lib/elevenlabs/tool-webhook.ts
git commit -m "feat(cohorts): stamp the dial day on every in-call booking"
```

---

## Phase 3 — Marking

### Task 3.1: Pure helper — which registration does a mark apply to?

**Files:**

- Create: `src/lib/goals/pick-registration.ts`
- Test: `tests/cohort-pick-registration.unit.test.ts`

**Rule:** the mark applies to the **most recent session that has already started and is still unmarked**. That matches the operator's actual workflow ("I am marking the webinar that just happened") and handles a rebooking sensibly.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";

import { pickRegistrationToMark } from "../src/lib/goals/pick-registration";

const NOW = new Date("2026-09-10T19:30:00Z"); // 3:30 PM ET, after the 2 PM

describe("pickRegistrationToMark", () => {
  it("picks the session that just happened", () => {
    const picked = pickRegistrationToMark(
      [
        { id: "a", scheduled_at: "2026-09-08T18:00:00Z", attended_at: null },
        { id: "b", scheduled_at: "2026-09-10T18:00:00Z", attended_at: null },
      ],
      NOW,
    );
    expect(picked?.id).toBe("b");
  });

  it("ignores a session that has not started yet", () => {
    const picked = pickRegistrationToMark(
      [
        { id: "a", scheduled_at: "2026-09-08T18:00:00Z", attended_at: null },
        { id: "b", scheduled_at: "2026-09-14T18:00:00Z", attended_at: null },
      ],
      NOW,
    );
    expect(picked?.id).toBe("a");
  });

  it("skips one already marked, so a re-mark does not overwrite history", () => {
    const picked = pickRegistrationToMark(
      [
        { id: "a", scheduled_at: "2026-09-08T18:00:00Z", attended_at: null },
        {
          id: "b",
          scheduled_at: "2026-09-10T18:00:00Z",
          attended_at: "2026-09-10T19:00:00Z",
        },
      ],
      NOW,
    );
    expect(picked?.id).toBe("a");
  });

  it("returns null when there is nothing markable", () => {
    expect(pickRegistrationToMark([], NOW)).toBeNull();
    expect(
      pickRegistrationToMark(
        [{ id: "a", scheduled_at: "2026-09-14T18:00:00Z", attended_at: null }],
        NOW,
      ),
    ).toBeNull();
  });

  it("ignores a registration with no session date at all", () => {
    expect(
      pickRegistrationToMark(
        [{ id: "a", scheduled_at: null, attended_at: null }],
        NOW,
      ),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/cohort-pick-registration.unit.test.ts`

Expected: FAIL — cannot resolve `../src/lib/goals/pick-registration`.

- [ ] **Step 3: Write the implementation**

```typescript
/** One registration, reduced to the fields that decide whether a pipeline mark
 *  belongs to it. Kept free of `server-only` so it unit-tests cleanly. */
export type MarkableRegistration = {
  id: string;
  scheduled_at: string | null;
  attended_at: string | null;
};

/**
 * Which of a lead's registrations a pipeline mark (attended / sale) applies to.
 *
 * The most recent session that has ALREADY STARTED and is still unmarked. That
 * is what the operator means when she marks someone after a webinar: "the one
 * that just happened". Picking the earliest instead would mis-assign a mark for
 * someone who no-showed once and came back — the exact case that made storing
 * the outcome on the lead untenable.
 *
 * Returns null when nothing qualifies (no registrations, all still upcoming, or
 * all already marked), in which case the caller should leave the lead status
 * change alone and surface nothing — a lead can be moved for other reasons.
 */
export function pickRegistrationToMark<T extends MarkableRegistration>(
  registrations: readonly T[],
  now: Date = new Date(),
): T | null {
  const started = registrations.filter(
    (r) =>
      r.attended_at === null &&
      r.scheduled_at !== null &&
      new Date(r.scheduled_at).getTime() <= now.getTime(),
  );
  if (started.length === 0) return null;
  return started.reduce((latest, r) =>
    new Date(r.scheduled_at as string).getTime() >
    new Date(latest.scheduled_at as string).getTime()
      ? r
      : latest,
  );
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run tests/cohort-pick-registration.unit.test.ts`

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/goals/pick-registration.ts tests/cohort-pick-registration.unit.test.ts
git commit -m "feat(cohorts): pick the registration a pipeline mark belongs to"
```

### Task 3.2: Add the `rescheduled` status

**Files:**

- Modify: `src/lib/goals/goal-statuses.ts`

- [ ] **Step 1: Add the value to both the type and the array**

```typescript
/** Goal-pipeline statuses on the lead. Kept in a non-"use server" file so
 *  client components (and the Goals page server component, transitively
 *  via client components) can import the constant directly. */
export type GoalStatus =
  | "goal_met"
  | "attended"
  | "no_show"
  | "rescheduled"
  | "sale"
  | "closed";

export const GOAL_STATUSES: GoalStatus[] = [
  "goal_met",
  "attended",
  "no_show",
  "rescheduled",
  "sale",
  "closed",
];
```

- [ ] **Step 2: Typecheck — this will surface every exhaustive switch that needs the new case**

Run: `npx tsc --noEmit`

Expected: errors in any file with an exhaustive `Record<GoalStatus, …>` or switch — most likely `src/app/(app)/goals/pipeline-funnel-bar.tsx` (the colour map) and `status-variant.ts`. Fix each by adding a `rescheduled` case. Use amber `#f59e0b`-adjacent styling in the funnel bar, matching `no_show` as a non-terminal state; the exact token should follow whatever the neighbouring entries use.

- [ ] **Step 3: Re-run typecheck**

Run: `npx tsc --noEmit`

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/lib/goals/goal-statuses.ts src/app/\(app\)/goals/
git commit -m "feat(cohorts): add a rescheduled stage to the goal pipeline"
```

### Task 3.3: Write marks through to the registration

**Files:**

- Modify: `src/lib/goals/pipeline-actions.ts`

- [ ] **Step 1: Stamp the registration alongside the lead**

After the existing lead update and before the `system_events` insert:

```typescript
// Write the outcome through to the REGISTRATION, which is the thing that
// owns it: leads.status is current-state only, so a no-show who rebooks and
// attends would otherwise overwrite their own history, and a data wipe would
// erase the outcome entirely. See the cohort reporting design doc.
if (input.status === "attended" || input.status === "sale") {
  const { data: regs } = await supabase
    .from("calendly_events")
    .select("id, scheduled_at, attended_at")
    .eq("lead_id", input.leadId)
    .neq("status", "canceled");
  const target = pickRegistrationToMark(regs ?? []);
  if (target) {
    const stamp = new Date().toISOString();
    await supabase
      .from("calendly_events")
      .update(
        input.status === "sale"
          ? { sale_at: stamp, attended_at: target.attended_at ?? stamp }
          : { attended_at: stamp },
      )
      .eq("id", target.id);
  }
}
```

Note the `sale` branch also backfills `attended_at`: a sale implies they attended, and without this the close rate divides by an attendee count that is missing them.

- [ ] **Step 2: Add the import**

```typescript
import { pickRegistrationToMark } from "./pick-registration";
```

- [ ] **Step 3: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint src/lib/goals/pipeline-actions.ts`

Expected: both clean.

- [ ] **Step 4: Verify against live data**

Mark one lead attended in the Goals pipeline, then:

```bash
node -e "/* query calendly_events for that lead_id and print attended_at */"
```

Expected: `attended_at` is set on exactly one registration — the most recent started one.

- [ ] **Step 5: Commit**

```bash
git add src/lib/goals/pipeline-actions.ts
git commit -m "feat(cohorts): pipeline marks write through to the registration"
```

### Task 3.4: The reschedule picker

**Files:**

- Create: `src/lib/goals/reschedule-actions.ts`
- Create: `src/app/(app)/goals/reschedule-dialog.tsx`
- Modify: `src/app/(app)/goals/pipeline-board.tsx`

- [ ] **Step 1: Write the server action**

```typescript
"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";

/**
 * Move a registration to a different session. `dial_day` is deliberately NOT
 * touched: the credit stays with the day whose spend produced the booking, no
 * matter how many times the session moves. The person returns to Upcoming on
 * the new date and can still be marked attended.
 */
export async function rescheduleRegistration(input: {
  leadId: string;
  registrationId: string;
  newSessionIso: string;
}): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const when = new Date(input.newSessionIso);
  if (Number.isNaN(when.getTime())) return { error: "Pick a valid session." };

  const { data: reg } = await supabase
    .from("calendly_events")
    .select("id, scheduled_at")
    .eq("id", input.registrationId)
    .maybeSingle();
  if (!reg) return { error: "Registration not found." };

  const { error } = await supabase
    .from("calendly_events")
    .update({
      scheduled_at: when.toISOString(),
      rescheduled_at: new Date().toISOString(),
    })
    .eq("id", input.registrationId);
  if (error) return { error: "Could not move the registration." };

  // Back to the upcoming stage — they can still attend.
  await supabase
    .from("leads")
    .update({ status: "scheduled" })
    .eq("id", input.leadId);

  await supabase.from("system_events").insert({
    kind: "registration_rescheduled",
    actor_user_id: user.id,
    ref_table: "calendly_events",
    ref_id: input.registrationId,
    payload: { from: reg.scheduled_at, to: when.toISOString() },
  });

  revalidatePath("/goals");
  return { error: null };
}
```

- [ ] **Step 2: Build the dialog**

A client component that lists the next 7 weekday 2 PM ET sessions (the webinar cadence) as radio options and calls `rescheduleRegistration`. Reuse the dialog primitives already used by `src/app/(app)/campaigns/campaign-settings-dialog.tsx` so the styling matches. Label each option with `etDateTime()` from `@/lib/time/eastern` — never a bare `toLocaleString`, which would render in the viewer's zone rather than ET.

- [ ] **Step 3: Wire the Rescheduled column**

In `pipeline-board.tsx`, dropping a card on `rescheduled` opens the dialog instead of calling `transitionLeadGoalStatus` directly. On cancel, the card returns to its original column.

- [ ] **Step 4: Typecheck, lint, build**

Run: `npx tsc --noEmit && npx eslint . && npm run build`

Expected: all clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/goals/reschedule-actions.ts src/app/\(app\)/goals/
git commit -m "feat(cohorts): move a registration to another session, keeping its dial day"
```

---

## Phase 4 — The report

### Task 4.1: The aggregation function

**Files:**

- Create: `supabase/migrations/20260905130000_cohort_rows_fn.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Per-dial-day cohort rows for the Reporting > Cohorts tab.
--
-- SECURITY INVOKER, deliberately: this runs as the CALLER so row-level security
-- applies. A SECURITY DEFINER function here (copying refresh_cost_rollup) would
-- bypass RLS and show every member every other member's leads, costs and
-- registrations through a report that looks correctly scoped.
--
-- Aggregation lives in SQL because PostgREST caps every response at 1000 rows;
-- counting 8k+ calls in JavaScript would silently undercount (cf. #218).
--
-- The connected-outcome list MUST stay in step with CONNECTED_OUTCOMES in
-- src/lib/calls/outcomes.ts.
create or replace function public.cohort_rows(p_start date, p_end date)
returns table (
  dial_day date,
  calls integer,
  connected integer,
  dms integer,
  regs integer,
  attended integer,
  no_show integer,
  rescheduled integer,
  sales integer,
  spend numeric,
  pending integer,
  last_session timestamptz
)
language sql
stable
security invoker
set search_path = public
as $$
  with days as (
    select generate_series(p_start, p_end, interval '1 day')::date as d
  ),
  call_stats as (
    select
      (c.created_at at time zone 'America/New_York')::date as d,
      count(*)::integer as calls,
      count(*) filter (
        where c.outcome in (
          'goal_met', 'callback', 'call_back_later', 'not_interested',
          'gatekeeper', 'gatekeeper_not_interested', 'transferred_to_human',
          'language_barrier', 'hung_up_immediately', 'hung_up_later', 'dnc'
        )
      )::integer as connected,
      count(*) filter (where l.decision_maker_reached)::integer as dms
    from calls c
    join leads l on l.id = c.lead_id
    where (c.created_at at time zone 'America/New_York')::date
          between p_start and p_end
    group by 1
  ),
  spend_stats as (
    select et_day as d, sum(total) as spend
    from cost_rollup_daily
    where et_day between p_start and p_end
    group by 1
  ),
  reg_stats as (
    select
      ce.dial_day as d,
      count(*) filter (where ce.status <> 'canceled')::integer as regs,
      count(*) filter (where ce.attended_at is not null)::integer as attended,
      count(*) filter (where ce.sale_at is not null)::integer as sales,
      count(*) filter (
        where ce.status <> 'canceled' and ce.rescheduled_at is not null
      )::integer as rescheduled,
      -- A session reconciles 24h after it ends. Unmarked after that = no-show.
      count(*) filter (
        where ce.status <> 'canceled'
          and ce.attended_at is null
          and ce.scheduled_at < now() - interval '24 hours'
      )::integer as no_show,
      count(*) filter (
        where ce.status <> 'canceled'
          and ce.scheduled_at >= now() - interval '24 hours'
      )::integer as pending,
      max(ce.scheduled_at) as last_session
    from calendly_events ce
    where ce.dial_day between p_start and p_end
    group by 1
  )
  select
    d.d,
    coalesce(cs.calls, 0),
    coalesce(cs.connected, 0),
    coalesce(cs.dms, 0),
    coalesce(rs.regs, 0),
    coalesce(rs.attended, 0),
    coalesce(rs.no_show, 0),
    coalesce(rs.rescheduled, 0),
    coalesce(rs.sales, 0),
    coalesce(ss.spend, 0),
    coalesce(rs.pending, 0),
    rs.last_session
  from days d
  left join call_stats cs on cs.d = d.d
  left join spend_stats ss on ss.d = d.d
  left join reg_stats rs on rs.d = d.d
  order by d.d desc;
$$;

grant execute on function public.cohort_rows(date, date) to authenticated;
```

- [ ] **Step 2: Apply and sanity-check against known numbers**

Run: `npx supabase db push --linked`

Then query it for 2026-09-02..2026-09-04 as an admin. Expected, from the verification already done: 9/2 → calls 2604, connected 870, dms 87, regs 5, attended 2, no_show 2, sales 0, spend 231.42. 9/3 → regs 10, attended 2. 9/4 → regs 5, attended 0, pending 5.

If `regs` for 9/3 reads 11, the cancellation filter is wrong.

- [ ] **Step 3: Verify RLS actually applies**

Query the function while authenticated as a **member**, not an admin, and confirm the rows only reflect leads that member owns. Reading the policy is not sufficient — the entire access model rests on this call being `SECURITY INVOKER`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260905130000_cohort_rows_fn.sql
git commit -m "feat(cohorts): SECURITY INVOKER SQL function for per-dial-day cohort rows"
```

### Task 4.2: Pure cohort maths

**Files:**

- Create: `src/lib/cohorts/math.ts`
- Test: `tests/cohort-math.unit.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";

import {
  costPer,
  isRipe,
  projectedCostPerSale,
  rollingRates,
  MIN_SHOW_SAMPLE,
  MIN_CLOSE_SAMPLE,
} from "../src/lib/cohorts/math";

const NOW = new Date("2026-09-20T12:00:00Z");

describe("costPer", () => {
  it("divides spend by outcomes", () => {
    expect(costPer(231.42, 5)).toBeCloseTo(46.284, 3);
  });

  it("returns null rather than Infinity when there are no outcomes", () => {
    // A day with spend and zero attendees must not render as $Infinity.
    expect(costPer(231.42, 0)).toBeNull();
  });

  it("returns null when there was no spend to divide", () => {
    expect(costPer(0, 3)).toBeNull();
  });
});

describe("isRipe", () => {
  it("is ripe once the last session is more than 7 days past", () => {
    expect(isRipe("2026-09-10T18:00:00Z", 0, NOW)).toBe(true);
  });

  it("is not ripe while a session is within the 7-day sales window", () => {
    expect(isRipe("2026-09-18T18:00:00Z", 0, NOW)).toBe(false);
  });

  it("is not ripe while any registration is still pending", () => {
    expect(isRipe("2026-09-10T18:00:00Z", 3, NOW)).toBe(false);
  });

  it("is not ripe for a day that produced no registrations at all", () => {
    expect(isRipe(null, 0, NOW)).toBe(false);
  });
});

describe("rollingRates", () => {
  it("computes show and close rates from reconciled registrations", () => {
    const r = rollingRates([
      { attended: 6, no_show: 6, sales: 3 },
      { attended: 6, no_show: 6, sales: 3 },
    ]);
    expect(r.showRate).toBeCloseTo(0.5, 5);
    expect(r.closeRate).toBeCloseTo(0.5, 5);
  });

  it("suppresses the show rate below the minimum sample", () => {
    const r = rollingRates([{ attended: 2, no_show: 1, sales: 1 }]);
    expect(r.showRate).toBeNull();
  });

  it("suppresses the close rate below the minimum attendee sample", () => {
    const r = rollingRates([{ attended: 4, no_show: 8, sales: 2 }]);
    expect(r.showRate).not.toBeNull();
    expect(r.closeRate).toBeNull();
  });

  it("handles a period with no data without dividing by zero", () => {
    const r = rollingRates([]);
    expect(r.showRate).toBeNull();
    expect(r.closeRate).toBeNull();
  });
});

describe("projectedCostPerSale", () => {
  it("divides cost per registration by the two conversion rates", () => {
    expect(projectedCostPerSale(37, 0.5, 0.2)).toBeCloseTo(370, 5);
  });

  it("returns null when either rate is unknown", () => {
    expect(projectedCostPerSale(37, null, 0.2)).toBeNull();
    expect(projectedCostPerSale(37, 0.5, null)).toBeNull();
  });

  it("returns null when a rate is zero, rather than Infinity", () => {
    expect(projectedCostPerSale(37, 0.5, 0)).toBeNull();
  });
});

describe("sample thresholds", () => {
  it("are the documented values", () => {
    expect(MIN_SHOW_SAMPLE).toBe(10);
    expect(MIN_CLOSE_SAMPLE).toBe(5);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/cohort-math.unit.test.ts`

Expected: FAIL — cannot resolve `../src/lib/cohorts/math`.

- [ ] **Step 3: Write the implementation**

```typescript
/** Pure cohort arithmetic. No `server-only`, no fetches — every rule that
 *  decides what a number MEANS lives here so it can be tested directly. */

/** A day is judgeable once its last session is this many days past. The sales
 *  window the operator chose: most deals close within a week of the webinar. */
export const SALES_WINDOW_DAYS = 7;

/** Below these, a rate is reported as unknown rather than printed off a handful
 *  of people. In the spirit of the best-time heatmap's 8-sample threshold. */
export const MIN_SHOW_SAMPLE = 10;
export const MIN_CLOSE_SAMPLE = 5;

/**
 * Spend per outcome, or null when the ratio would be meaningless. Returning
 * null rather than Infinity matters: a day with real spend and zero attendees
 * is the NORMAL state of an unripe cohort, and must render as "—", never as an
 * alarming number.
 */
export function costPer(spend: number, outcomes: number): number | null {
  if (!Number.isFinite(spend) || spend <= 0) return null;
  if (!Number.isFinite(outcomes) || outcomes <= 0) return null;
  return spend / outcomes;
}

/**
 * Whether a dial day's row has stopped changing and can be judged. Requires
 * both that nothing is still pending and that the last session is past the
 * sales window — a session can be over while the sale it produces is not.
 */
export function isRipe(
  lastSessionIso: string | null,
  pending: number,
  now: Date = new Date(),
): boolean {
  if (!lastSessionIso) return false;
  if (pending > 0) return false;
  const last = new Date(lastSessionIso).getTime();
  if (Number.isNaN(last)) return false;
  return now.getTime() - last > SALES_WINDOW_DAYS * 86_400_000;
}

export type RateInput = {
  attended: number;
  no_show: number;
  sales: number;
};

export type Rates = {
  showRate: number | null;
  closeRate: number | null;
};

/**
 * Show and close rates over a set of cohort rows. The show-rate denominator is
 * only RECONCILED registrations (attended + no-show) — anyone whose session has
 * not happened yet must not drag the rate down.
 */
export function rollingRates(rows: readonly RateInput[]): Rates {
  const attended = rows.reduce((n, r) => n + r.attended, 0);
  const noShow = rows.reduce((n, r) => n + r.no_show, 0);
  const sales = rows.reduce((n, r) => n + r.sales, 0);
  const reconciled = attended + noShow;
  return {
    showRate: reconciled >= MIN_SHOW_SAMPLE ? attended / reconciled : null,
    closeRate: attended >= MIN_CLOSE_SAMPLE ? sales / attended : null,
  };
}

/**
 * What a sale should cost, given today's cost per registration and how the
 * funnel has been converting. This is the number that can be steered by TODAY,
 * before any cohort has ripened.
 */
export function projectedCostPerSale(
  costPerRegistration: number | null,
  showRate: number | null,
  closeRate: number | null,
): number | null {
  if (costPerRegistration === null || costPerRegistration <= 0) return null;
  if (showRate === null || showRate <= 0) return null;
  if (closeRate === null || closeRate <= 0) return null;
  return costPerRegistration / (showRate * closeRate);
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run tests/cohort-math.unit.test.ts`

Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/cohorts/math.ts tests/cohort-math.unit.test.ts
git commit -m "feat(cohorts): pure cohort maths — ripeness, rates, projection"
```

### Task 4.3: Data loader

**Files:**

- Create: `src/lib/cohorts/data.ts`

- [ ] **Step 1: Write the loader**

```typescript
import "server-only";

import { createClient } from "@/lib/supabase/server";
import { etDateDaysAgo, etDayString } from "@/lib/time/eastern";

export type CohortRow = {
  dial_day: string;
  calls: number;
  connected: number;
  dms: number;
  regs: number;
  attended: number;
  no_show: number;
  rescheduled: number;
  sales: number;
  spend: number;
  pending: number;
  last_session: string | null;
};

/**
 * Cohort rows for the last `days` ET days. The RPC is SECURITY INVOKER, so the
 * caller's RLS decides which leads are counted — a member sees only their own.
 * No pagination needed: one row per day, not one per call.
 */
export async function fetchCohortRows(days = 30): Promise<CohortRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("cohort_rows", {
    p_start: etDateDaysAgo(days),
    p_end: etDayString(),
  });
  if (error) throw new Error(`cohort_rows: ${error.message}`);
  return (data ?? []) as CohortRow[];
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`

Expected: clean. If `rpc("cohort_rows")` is not typed, the database types were not regenerated after Task 4.1 — re-run the `gen types` command from Task 2.1 Step 4.

- [ ] **Step 3: Commit**

```bash
git add src/lib/cohorts/data.ts
git commit -m "feat(cohorts): load cohort rows through the RPC"
```

### Task 4.4: The Cohorts view

**Files:**

- Create: `src/app/(app)/reporting/cohorts-view.tsx`

- [ ] **Step 1: Build the view**

A Server Component rendering two things:

1. **The rolling-rates panel** — show rate, close rate, today's cost per registration, projected cost per sale. Each renders "not enough data yet" when `null`, never a zero or a dash without explanation.
2. **The cohort table** — the columns from the spec, newest day first. Ratios from `costPer()`; a `null` renders `—`. Rows where `isRipe()` is false render their three ratio cells in muted italics and show `N pending` in the Status column; ripe rows show `Final`.

Wrap the table in `overflow-x: auto` — 14 columns will not fit a narrow viewport.

Any session that reconciled with zero attendance marks raises an inline warning above the table, linking to `/goals`, with wording along the lines of: "Monday 2 PM: 8 registered, nobody marked attended. If that's wrong, mark them on Goals."

Format every date and time with the `et*` helpers from `@/lib/time/eastern` — never a bare `toLocaleDateString`, which renders in the viewer's timezone.

- [ ] **Step 2: Build and lint**

Run: `npm run build && npx eslint src/app/\(app\)/reporting/cohorts-view.tsx`

Expected: both clean.

- [ ] **Step 3: Commit**

```bash
git add src/app/\(app\)/reporting/cohorts-view.tsx
git commit -m "feat(cohorts): the Cohorts view"
```

### Task 4.5: Tabs — add Cohorts, remove VoC and Hot Leads, gate by role

**Files:**

- Modify: `src/app/(app)/reporting/reporting-tabs.tsx`
- Delete: `src/app/(app)/reporting/voice-table.tsx`, `src/app/(app)/reporting/hot-leads-table.tsx`

- [ ] **Step 1: Rewrite the tab list and the filter**

```typescript
export const REPORTING_TABS = [
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { key: "cohorts", label: "Cohorts", icon: CalendarClock },
  { key: "cause-of-death", label: "Cause of Death", icon: HeartCrack },
  { key: "numbers", label: "Numbers", icon: PhoneCall },
  { key: "changelog", label: "App Changelog", icon: History },
  { key: "prompt-log", label: "Agent Prompt Log", icon: Bot },
] as const;

/** The tabs to show for the current audience. Numbers is hidden from the public
 *  share: it lists our own phone numbers and which are burned or resting — a
 *  shopping list for anyone wanting to report them as spam.
 *
 *  App Changelog and Agent Prompt Log are hidden from MEMBERS because their RLS
 *  is admin-only (`app_changelog_admin_all`, `agent_prompt_log_admin_all`), so
 *  a member would be shown a permanently empty table. Hiding beats explaining. */
export function reportingTabsFor({
  showNumbers = true,
  isAdmin = true,
}: {
  showNumbers?: boolean;
  isAdmin?: boolean;
} = {}): readonly (typeof REPORTING_TABS)[number][] {
  return REPORTING_TABS.filter((t) => {
    if (t.key === "numbers") return showNumbers;
    if (t.key === "changelog" || t.key === "prompt-log") return isAdmin;
    return true;
  });
}
```

Import `CalendarClock` from `lucide-react` and drop the now-unused `Flame` and `MessageSquare` imports.

- [ ] **Step 2: Delete the two view components**

```bash
git rm src/app/\(app\)/reporting/voice-table.tsx src/app/\(app\)/reporting/hot-leads-table.tsx
```

- [ ] **Step 3: Typecheck — this surfaces every remaining reference**

Run: `npx tsc --noEmit`

Expected: errors in `page.tsx` and the share page for the deleted imports and the removed tab keys, plus any now-unused data loaders in `src/lib/agent-analytics/report-data.ts`. Remove the dead loaders too — leaving them is how a codebase accumulates functions nobody calls. Do **not** touch the `ai_answering_stance` extraction or the `hot_lead_dismissals` table; Cause of Death still uses that data and dropping it is out of scope.

- [ ] **Step 4: Re-run typecheck and lint**

Run: `npx tsc --noEmit && npx eslint .`

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add -A src/app/\(app\)/reporting/ src/lib/agent-analytics/
git commit -m "feat(reporting): add Cohorts, remove Voice of Customer and Hot Leads"
```

### Task 4.6: Open Reporting to members

**Files:**

- Modify: `src/app/(app)/reporting/page.tsx:70` and its tab wiring

- [ ] **Step 1: Replace the redirect with a role-aware tab list**

Delete `if (me?.role !== "admin") redirect("/");` and derive the allowed tabs instead:

```typescript
const isAdmin = me?.role === "admin";
const allowedTabs = reportingTabsFor({ showNumbers: true, isAdmin });
const requested =
  typeof searchParams.tab === "string" ? searchParams.tab : "dashboard";
// A member deep-linking to an admin-only tab lands on Dashboard rather than an
// empty table. The tab list is the authority — never the raw query parameter.
const tab = allowedTabs.some((t) => t.key === requested)
  ? requested
  : "dashboard";
```

- [ ] **Step 2: Gate the data loading on the resolved tab**

Every admin-only query (`dashboard_notes`, the changelog, the prompt log) must run only when its tab is the resolved one **and** `isAdmin` is true. A member request must not fire an admin-only query and swallow the empty result — it should not fire at all.

- [ ] **Step 3: Verify as a member, not by reading the code**

Sign in as a member account and confirm: `/reporting` loads; only Dashboard, Cohorts, Cause of Death and Numbers appear; every figure reflects only that member's own leads; `/reporting?tab=prompt-log` redirects to Dashboard rather than rendering.

This is the step that catches a `SECURITY DEFINER` slip in Task 4.1. Do not skip it.

- [ ] **Step 4: Confirm the public share still hides Numbers**

Load `/share/reporting/<token>` and confirm Numbers is still absent and Cohorts does not appear — the share passes `showNumbers: false` and must not gain the cohort tab.

- [ ] **Step 5: Build**

Run: `npm run build`

Expected: clean.

- [ ] **Step 6: Commit and open the PR**

```bash
git add src/app/\(app\)/reporting/page.tsx
git commit -m "feat(reporting): members can read Reporting, scoped to their own leads"
git push
```

---

## Self-Review

**Spec coverage:** Every spec section maps to a task — wipe changes → 1.1–1.3; data model → 2.1; `dial_day` stamping → 2.2; registration states and marking → 3.1–3.3; rescheduling → 3.4; read path → 4.1, 4.3; rolling rates and thresholds → 4.2; the report → 4.4; access model and tab removal → 4.5–4.6.

**Known gap, deliberately left:** the spec's "auto-reconcile 24 hours after the session ends" is implemented as a _query predicate_ (`scheduled_at < now() - interval '24 hours'`) rather than a stored flag or a cron job. That is simpler and has no moving parts, and the warning in Task 4.4 covers the case it exists to catch. If a stored reconciliation state is ever needed, it becomes a column, not a rewrite.

**Type consistency:** `pickRegistrationToMark` is used with the same field names it defines (`id`, `scheduled_at`, `attended_at`) in Task 3.3. `CohortRow` in Task 4.3 matches the SQL function's `returns table` columns in Task 4.1 exactly, and the `RateInput` fields (`attended`, `no_show`, `sales`) are a subset of it.
