# Double Calling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an outbound call hits voicemail on an opted-in campaign, redial the same lead from the same number within ~30 seconds.

**Architecture:** On call 1 the retry engine advances the lead's retry cycle exactly as it does today, and additionally stamps a short-lived `redial_at` marker. The `dial_queue` view gains a second eligibility branch for markers younger than 10 minutes, sorted so redials aren't starved behind due leads. Placement reuses the first call's number and marks the new call `is_redial`. On call 2 that flag does two things: it stops a third redial, and it suppresses the retry-cycle advance — call 1 already advanced, and advancing twice would overwrite call 1's schedule (at retry position 2 that turns a 15-day cool-off into 2 days) and double-count the attempt.

**Tech Stack:** Next.js (App Router), TypeScript, Supabase/Postgres (pg_cron, RLS, views), Vitest (unit), Playwright (integration against live DB).

**Spec:** `docs/superpowers/specs/2026-07-27-double-call-design.md`

**Verification commands** (this repo has no CI — run these before every commit):

```bash
npx tsc --noEmit && npx eslint <changed files> && npx vitest run && npm run build
```

---

## File Structure

| File                                                   | Responsibility                                                  |
| ------------------------------------------------------ | --------------------------------------------------------------- |
| `supabase/migrations/20260728120000_double_call.sql`   | 4 columns, 1 index, `dial_queue` view rewrite                   |
| `src/lib/dialer/redial.ts` (new)                       | Pure trigger predicate. No I/O, so the rule is unit-testable    |
| `src/lib/dialer/retry-engine.ts`                       | Stamps the marker after advancing the cycle                     |
| `src/lib/dialer/number-pool.ts`                        | `usableRedialNumber()` — is the original number still dialable? |
| `src/lib/dialer/queue.ts`                              | Carries `is_redial_due` / `redial_number_id` out of the view    |
| `src/lib/dialer/tick.ts`                               | Reuses the number, marks the call, clears the marker            |
| `src/lib/campaigns/actions.ts`                         | Persists the toggle                                             |
| `src/app/(app)/campaigns/campaign-settings-dialog.tsx` | The checkbox                                                    |
| `src/app/(app)/campaigns/page.tsx`                     | Selects + passes the column                                     |
| `src/lib/supabase/database.types.ts`                   | Hand-added column types (this repo edits these by hand)         |
| `tests/redial-trigger.unit.test.ts` (new)              | The predicate                                                   |
| `tests/double-call.spec.ts` (new)                      | End-to-end against the live DB                                  |

---

### Task 1: Migration — columns, index, and the queue view

**Files:**

- Create: `supabase/migrations/20260728120000_double_call.sql`

- [ ] **Step 1: Write the migration**

The view must be written out in full — `create or replace view` replaces the whole definition. This is the current view from `20260721120000_restore_dialer_rules.sql` with three changes, each marked `-- DOUBLE CALL`.

```sql
-- Double calling: when a call hits voicemail on an opted-in campaign, redial the
-- same lead from the same number straight away.
--
-- The retry cycle still advances on call 1 (see retry-engine.ts), so the lead's
-- next_call_at is already correct two days out. The redial rides on its own
-- short-lived marker: if it cannot fire (calling hours, caps, paused campaign,
-- empty pool) the window simply expires and nothing needs unwinding.
--
-- See docs/superpowers/specs/2026-07-27-double-call-design.md

alter table public.campaigns
  add column if not exists double_call_enabled boolean not null default false;

comment on column public.campaigns.double_call_enabled is
  'When true, a voicemail at retry position 0 or 2 schedules an immediate '
  'redial of the same lead from the same number. Off by default.';

alter table public.leads
  add column if not exists redial_at timestamptz,
  add column if not exists redial_number_id uuid
    references public.twilio_numbers (id) on delete set null;

comment on column public.leads.redial_at is
  'A pending double-call redial, valid for 10 minutes from this timestamp. '
  'Left in place once stale (the queue ignores it); the next qualifying '
  'voicemail overwrites it. There is no sweeper and none is needed.';

alter table public.calls
  add column if not exists is_redial boolean not null default false;

comment on column public.calls.is_redial is
  'True when this call is the second half of a double-call pair. Such a call '
  'never advances the retry cycle (call 1 already did) and never schedules '
  'another redial.';

-- Deliberately NO index on redial_at. Its predicate sits inside a top-level OR
-- in the view, and Postgres can only use an index across an OR via BitmapOr,
-- which needs an indexable path for EVERY branch — leads has no next_call_at
-- index. Nothing else filters on redial_at (the retry engine writes by id, and
-- there is no sweeper by design), so an index here would be write amplification
-- on a hot table with no read to serve.

-- ---------------------------------------------------------------------------
-- dial_queue: add the redial branch
-- ---------------------------------------------------------------------------
create or replace view public.dial_queue
with (security_invoker = true)
as
select
  q.lead_id,
  q.owner_id,
  q.business_phone,
  q.lead_timezone,
  q.next_call_at,
  q.campaign_id,
  q.agent_id,
  q.twilio_number_id,
  q.calling_hours_start,
  q.calling_hours_end,
  q.calls_per_hour_cap,
  q.calls_per_day_cap,
  q.concurrency_cap_per_user,
  q.daily_spend_cap,
  q.monthly_spend_cap,
  q.dial_priority,
  q.is_redial_due,        -- DOUBLE CALL
  q.redial_number_id,     -- DOUBLE CALL
  q.queue_order           -- DOUBLE CALL
from (
  select
    l.id as lead_id,
    l.owner_id,
    l.business_phone,
    l.timezone as lead_timezone,
    l.next_call_at,
    c.id as campaign_id,
    c.created_at as campaign_created_at,
    c.agent_id,
    c.twilio_number_id,
    c.calling_hours_start,
    c.calling_hours_end,
    c.calls_per_hour_cap,
    c.calls_per_day_cap,
    c.concurrency_cap_per_user,
    c.daily_spend_cap,
    c.monthly_spend_cap,
    (case when l.status = 'callback' then 0 else 1 end) as dial_priority,
    -- DOUBLE CALL: a marker inside its 10-minute window. Computed here rather
    -- than inferred in TS, because a lead can surface via next_call_at while
    -- carrying a STALE marker — that is not a redial and must not be marked one.
    -- The upper bound is NOT redundant: redial_at is stamped from the app
    -- server's clock and compared against the database's, so a future value
    -- (clock skew, a manual fix, a test seed) would satisfy a one-sided
    -- predicate forever and pin this lead in the queue on every tick. There is
    -- deliberately no sweeper to catch that.
    (l.redial_at is not null
      and l.redial_at > now() - interval '10 minutes'
      and l.redial_at <= now()) as is_redial_due,
    l.redial_number_id,
    -- DOUBLE CALL: sort key. A redial's next_call_at is two days in the FUTURE
    -- (the cycle advanced on call 1), so ordering on next_call_at alone would
    -- bury it behind every due lead and it would never fire inside its window.
    coalesce(
      case
        when l.redial_at is not null
         and l.redial_at > now() - interval '10 minutes'
         and l.redial_at <= now()
        then l.redial_at
      end,
      l.next_call_at
    ) as queue_order
  from public.leads l
  join public.campaigns c
    on c.owner_id = l.owner_id
    and c.status = 'active'
    -- Autopilot pauses COLD outreach only. A scheduled callback is a promise to
    -- a person, so it still runs with autopilot off.
    and (c.autopilot_enabled = true or l.status = 'callback')
    -- Shared lists: a lead belongs to the campaign that first dialled it, and
    -- no other campaign may touch it until that campaign releases it (which
    -- happens when the list is detached -- see list-attachments-actions.ts).
    and (l.owner_campaign_id is null or l.owner_campaign_id = c.id)
    and (
      exists (
        select 1 from public.list_campaign_attachments lca
        where lca.campaign_id = c.id
          and lca.list_id = l.list_id
          and lca.detached_at is null
      )
      or (
        c.audience_search is not null
        and l.company is not null
        and l.company ilike '%' || c.audience_search || '%'
      )
      or (
        c.smart_list_id is not null
        and exists (
          select 1 from public.smart_list_members slm
          where slm.smart_list_id = c.smart_list_id
            and slm.lead_id = l.id
        )
      )
    )
  where
    l.deleted_at is null
    and l.business_phone is not null
    and l.status in ('ready_to_call', 'callback')
    -- DOUBLE CALL: due on the normal clock, OR carrying a live redial marker.
    and (
          (l.next_call_at is null or l.next_call_at <= now())
       or (l.redial_at is not null
           and l.redial_at > now() - interval '10 minutes'
           and l.redial_at <= now())
    )
    -- Pool gate (the number itself is chosen at placement by selectPoolNumber).
    and exists (
      select 1 from public.twilio_numbers tn
       where tn.attached_campaign_id = c.id
         and tn.released_at is null
         and tn.pool_status = 'active'
         and tn.flagged_for_rotation = false
         and tn.elevenlabs_phone_number_id is not null
    )
    -- Never AI-dial a mobile (mirrors pre_call_check; human dialling bypasses).
    and l.line_type is distinct from 'mobile'
    and not exists (
      select 1 from public.dnc_entries d
      where d.phone = l.business_phone
    )
    -- Scheduled callbacks run whenever they were booked for -- no window, no
    -- weekday gate. Cold outreach: campaign hours, weekdays only.
    and (
      l.status = 'callback'
      or public.is_within_calling_hours(
        l.timezone, c.calling_hours_start, c.calling_hours_end, false
      )
    )
) q
-- The band matters more than the sort key. queue_order ALONE puts a due redial
-- LAST: its timestamp is ~30s old while a backlog lead's next_call_at is days
-- old, and ascending means oldest first. is_redial_due desc lifts due redials to
-- the front of their priority tier; queue_order is only the tiebreak WITHIN a
-- band. Callbacks stay ahead of everything via dial_priority.
order by q.dial_priority, q.is_redial_due desc, q.queue_order nulls first;

comment on view public.dial_queue is
  'Leads eligible for the AUTO-dialer: ready, due (or carrying a live '
  'double-call redial marker), not on DNC, not a mobile, owned by this campaign '
  '(or unowned), targeted by an attached list / audience search / smart list, on '
  'an active campaign with >=1 usable pool number. Autopilot gates COLD leads '
  'only -- scheduled callbacks run regardless. dial_priority orders callbacks (0) '
  'ahead of cold leads (1); within a tier, is_redial_due puts a due redial first '
  'and queue_order is only the tiebreak within a band. The specific number is chosen at '
  'placement by selectPoolNumber, except on a redial which reuses call 1''s.';
```

- [ ] **Step 2: Apply to prod and verify the view still returns rows**

```bash
npx supabase db push --linked
```

Expected: `Applying migration 20260728120000_double_call.sql...` then `Finished supabase db push.`

Then confirm the view still works and the new columns are present:

```bash
node -e '
require("dotenv").config({path:".env.local"});
const U=process.env.NEXT_PUBLIC_SUPABASE_URL, K=process.env.SUPABASE_SERVICE_ROLE_KEY;
const h={apikey:K,Authorization:"Bearer "+K};
(async()=>{
 const r=await fetch(U+"/rest/v1/dial_queue?select=lead_id,is_redial_due,redial_number_id,queue_order&limit=3",{headers:h});
 console.log("dial_queue:", r.status, JSON.stringify(await r.json()).slice(0,300));
 const c=await fetch(U+"/rest/v1/campaigns?select=id,double_call_enabled",{headers:h});
 console.log("campaigns:", JSON.stringify(await c.json()));
})();
'
```

Expected: status 200 on both, `double_call_enabled: false` on every campaign.

- [ ] **Step 3: Add the column types**

In `src/lib/supabase/database.types.ts`, add to the `campaigns` table's `Row`/`Insert`/`Update`:

```ts
          double_call_enabled: boolean;      // Row
          double_call_enabled?: boolean;     // Insert and Update
```

to `leads`:

```ts
          redial_at: string | null;          // Row
          redial_number_id: string | null;   // Row
          redial_at?: string | null;         // Insert and Update
          redial_number_id?: string | null;  // Insert and Update
```

to `calls`:

```ts
          is_redial: boolean;                // Row
          is_redial?: boolean;               // Insert and Update
```

and to the `dial_queue` view's `Row`:

```ts
is_redial_due: boolean | null;
redial_number_id: string | null;
queue_order: string | null;
```

- [ ] **Step 4: Verify types compile**

Run: `npx tsc --noEmit`
Expected: no output, exit 0.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260728120000_double_call.sql src/lib/supabase/database.types.ts
git commit -m "feat(dialer): schema + queue branch for double calling"
```

---

### Task 2: The trigger predicate

A pure function so the rule can be tested without a database. Mirrors how `pool-plan.ts` and `shortlinks/destination.ts` isolate their logic.

**Files:**

- Create: `src/lib/dialer/redial.ts`
- Test: `tests/redial-trigger.unit.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";

import { shouldScheduleRedial } from "@/lib/dialer/redial";

/** An opted-in campaign, first cold call, hit voicemail — the case that fires. */
const FIRES = {
  doubleCallEnabled: true,
  outcome: "voicemail" as string | null,
  isRedial: false,
  retryPositionBefore: 0,
};

describe("shouldScheduleRedial", () => {
  it("fires on the happy path", () => {
    expect(shouldScheduleRedial(FIRES)).toBe(true);
  });

  it("never fires when the campaign has not opted in", () => {
    expect(shouldScheduleRedial({ ...FIRES, doubleCallEnabled: false })).toBe(
      false,
    );
  });

  it("fires only on voicemail", () => {
    for (const outcome of [
      "no_answer",
      "busy",
      "failed",
      "gatekeeper",
      "goal_met",
      "not_interested",
      "hung_up_immediately",
      "ai_receptionist",
      null,
    ]) {
      expect(shouldScheduleRedial({ ...FIRES, outcome })).toBe(false);
    }
  });

  it("fires at retry positions 0 and 2, never at 1", () => {
    expect(shouldScheduleRedial({ ...FIRES, retryPositionBefore: 0 })).toBe(
      true,
    );
    expect(shouldScheduleRedial({ ...FIRES, retryPositionBefore: 1 })).toBe(
      false,
    );
    expect(shouldScheduleRedial({ ...FIRES, retryPositionBefore: 2 })).toBe(
      true,
    );
  });

  it("handles a retry position that has run past 2", () => {
    // retry_position is stored modulo 3 by the engine, but never trust it.
    expect(shouldScheduleRedial({ ...FIRES, retryPositionBefore: 3 })).toBe(
      true,
    );
    expect(shouldScheduleRedial({ ...FIRES, retryPositionBefore: 4 })).toBe(
      false,
    );
    expect(shouldScheduleRedial({ ...FIRES, retryPositionBefore: 5 })).toBe(
      true,
    );
  });

  it("never lets a redial spawn another redial", () => {
    expect(shouldScheduleRedial({ ...FIRES, isRedial: true })).toBe(false);
    expect(
      shouldScheduleRedial({
        ...FIRES,
        isRedial: true,
        retryPositionBefore: 2,
      }),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/redial-trigger.unit.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/dialer/redial"`.

- [ ] **Step 3: Write the implementation**

```ts
/**
 * Whether a finished call should schedule an immediate redial of the same lead
 * from the same number ("double calling").
 *
 * Pure, so the rule is testable without a database — this decides whether a
 * second real phone call gets placed, so it earns its own tests.
 *
 * See docs/superpowers/specs/2026-07-27-double-call-design.md
 */

/** Retry-cycle positions that get doubled: the opener and the step before the
 *  15-day gap. Position 1 (the middle 2-day step) is left as a single call. */
const DOUBLED_POSITIONS = new Set([0, 2]);

export function shouldScheduleRedial(input: {
  /** The campaign's opt-in. */
  doubleCallEnabled: boolean;
  /** The finished call's outcome. */
  outcome: string | null;
  /** Whether the finished call was ITSELF the second half of a pair. */
  isRedial: boolean;
  /** The lead's retry_position BEFORE the cycle advanced for this call. */
  retryPositionBefore: number;
}): boolean {
  if (!input.doubleCallEnabled) return false;
  // Voicemail only. no_answer is arguably the same from the lead's side, and
  // busy is indistinguishable from a manual decline on most carriers — see the
  // spec's Decisions section.
  if (input.outcome !== "voicemail") return false;
  // A pair is two calls, never three.
  if (input.isRedial) return false;
  return DOUBLED_POSITIONS.has(((input.retryPositionBefore % 3) + 3) % 3);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/redial-trigger.unit.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/dialer/redial.ts tests/redial-trigger.unit.test.ts
git commit -m "feat(dialer): pure predicate for the double-call trigger"
```

---

### Task 3: Retry engine stamps the marker

**Files:**

- Modify: `src/lib/dialer/retry-engine.ts`

- [ ] **Step 1: Import the predicate**

Add below the existing `local-schedule` import:

```ts
import { shouldScheduleRedial } from "@/lib/dialer/redial";
```

- [ ] **Step 2: Select the two extra call columns**

Find the compare-and-swap claim (~line 142) and extend its `.select(...)`:

```ts
    .select(
      "id, lead_id, campaign_id, outcome, status, is_redial, twilio_number_id",
    );
```

- [ ] **Step 3: Select the campaign's opt-in**

Find the parallel lead/campaign fetch (~line 198) and extend the campaign select:

```ts
    supabase
      .from("campaigns")
      .select(
        "smart_scheduling, calling_hours_start, calling_hours_end, double_call_enabled",
      )
      .eq("id", call.campaign_id ?? "")
      .maybeSingle(),
```

- [ ] **Step 4: Capture the pre-advance position and stamp the marker**

Directly above the final lead update (`const { error: leadError } = await supabase.from("leads").update(update)`, ~line 351), insert:

```ts
// Double calling: a voicemail at the opener or the pre-15-day step schedules
// an immediate redial from the SAME number. The cycle has already advanced
// above, so this marker is purely additive — if it can't be consumed (calling
// hours, caps, paused campaign, empty pool) the queue's 10-minute window
// closes and the lead is already scheduled correctly. Nothing to unwind.
//
// Read the position from the LEAD as it was fetched, not from `update`, which
// applyUnifiedRetryCycle has already overwritten with the NEXT position.
if (
  shouldScheduleRedial({
    doubleCallEnabled: campaign?.double_call_enabled ?? false,
    outcome: call.outcome,
    isRedial: call.is_redial ?? false,
    retryPositionBefore: lead?.retry_position ?? 0,
  })
) {
  update.redial_at = new Date().toISOString();
  update.redial_number_id = call.twilio_number_id;
}
```

Note the callback-escalation branch (~line 228) returns early, so a voicemail on
a lead with a pending callback never reaches this — which is correct, that
callback has its own +30min → next-day → missed ladder.

- [ ] **Step 5: Verify it compiles and nothing regressed**

Run: `npx tsc --noEmit && npx vitest run`
Expected: exit 0; all existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/dialer/retry-engine.ts
git commit -m "feat(dialer): stamp a redial marker on a qualifying voicemail"
```

---

### Task 4: Reuse the original number

**Files:**

- Modify: `src/lib/dialer/number-pool.ts`

- [ ] **Step 1: Add the helper**

Append to `src/lib/dialer/number-pool.ts`:

```ts
/**
 * Resolve a SPECIFIC pool number for a double-call redial, or null when it is no
 * longer dialable. Applies the same health gates as `selectPoolNumber` — still
 * attached to this campaign, active, not released, not flagged, not resting, and
 * imported into ElevenLabs — but deliberately ignores usage and area code: the
 * whole point is that the lead sees the SAME number ring twice.
 */
export async function usableRedialNumber(
  db: Admin,
  campaignId: string,
  numberId: string,
): Promise<{ numberId: string; elevenlabsPhoneNumberId: string } | null> {
  const nowIso = new Date().toISOString();
  const { data } = await db
    .from("twilio_numbers")
    .select("id, elevenlabs_phone_number_id")
    .eq("id", numberId)
    .eq("attached_campaign_id", campaignId)
    .is("released_at", null)
    .eq("pool_status", "active")
    .eq("flagged_for_rotation", false)
    .not("elevenlabs_phone_number_id", "is", null)
    .or(`rested_until.is.null,rested_until.lte.${nowIso}`)
    .maybeSingle();
  if (!data?.elevenlabs_phone_number_id) return null;
  return {
    numberId: data.id,
    elevenlabsPhoneNumberId: data.elevenlabs_phone_number_id,
  };
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/lib/dialer/number-pool.ts
git commit -m "feat(dialer): resolve a specific pool number for a redial"
```

---

### Task 5: Queue and tick wiring

**Files:**

- Modify: `src/lib/dialer/queue.ts`
- Modify: `src/lib/dialer/tick.ts`

- [ ] **Step 1: Carry the redial fields out of the view**

In `src/lib/dialer/queue.ts`, extend the type:

```ts
/** One row out of the dial_queue view. */
export type DialQueueEntry = {
  lead_id: string;
  owner_id: string;
  business_phone: string;
  campaign_id: string;
  agent_id: string | null;
  twilio_number_id: string | null;
  /** True when this row surfaced because of a live double-call marker. */
  is_redial_due: boolean;
  /** The number call 1 used, to be reused for the redial. */
  redial_number_id: string | null;
};
```

and the query — note the ORDER BY changes from `next_call_at` to `queue_order`,
which is what puts a due redial ahead of leads scheduled further out:

```ts
const { data } = await supabase
  .from("dial_queue")
  .select(
    "lead_id, owner_id, business_phone, campaign_id, agent_id, twilio_number_id, is_redial_due, redial_number_id",
  )
  .order("dial_priority", { ascending: true })
  // The band matters more than the sort key. queue_order ALONE puts a redial
  // LAST: its timestamp is ~30s old while a backlog lead's next_call_at is days
  // old, and ascending means oldest first. With ~33k due leads and a 50-row
  // limit it would never surface inside its window.
  .order("is_redial_due", { ascending: false })
  .order("queue_order", { ascending: true, nullsFirst: true })
  .limit(limit);
```

and the type guard, so a null from the view becomes a definite boolean:

```ts
return (data ?? [])
  .filter(
    (row) =>
      typeof row.lead_id === "string" &&
      typeof row.owner_id === "string" &&
      typeof row.business_phone === "string" &&
      typeof row.campaign_id === "string",
  )
  .map((row) => ({
    ...row,
    is_redial_due: row.is_redial_due === true,
  })) as DialQueueEntry[];
```

- [ ] **Step 2: Clear the marker once the lead is claimed**

In `src/lib/dialer/tick.ts`, immediately after the `claimLeadForDial` success
check (just below `lastDialAtByCampaign.set(...)`, ~line 388), insert:

```ts
// Consume the redial marker as soon as we own the lead. Clearing here rather
// than after placement means a failed placement can't leave the lead looping
// on the same marker for the rest of its 10-minute window.
if (c.is_redial_due) {
  await supabase
    .from("leads")
    .update({ redial_at: null, redial_number_id: null })
    .eq("id", c.lead_id);
}
```

- [ ] **Step 3: Pass the redial context into placement**

In the same file, extend the `placeLiveDialerCall` call (~line 394):

```ts
const res = await placeLiveDialerCall(supabase, {
  lead_id: c.lead_id,
  campaign_id: c.campaign_id,
  agent_id: c.agent_id,
  twilio_number_id: null,
  business_phone: c.business_phone,
  is_redial: c.is_redial_due,
  redial_number_id: c.redial_number_id,
});
```

- [ ] **Step 4: Use the stored number and mark the call**

Update `placeLiveDialerCall`'s signature and number selection:

```ts
async function placeLiveDialerCall(
  supabase: SupabaseAdmin,
  c: {
    lead_id: string;
    campaign_id: string;
    agent_id: string | null;
    twilio_number_id: string | null;
    business_phone: string | null;
    is_redial?: boolean;
    redial_number_id?: string | null;
  },
): Promise<LivePlaceResult> {
  if (!c.business_phone) return { callId: null };

  // A double-call redial reuses call 1's number so the lead sees the SAME caller
  // ring twice — that recognition is the entire point of the second call.
  //
  // If that number is no longer dialable (retired, rested, flagged) we place NO
  // call rather than falling back to the pool: two calls a minute apart from two
  // different caller IDs is the spam pattern the same-number rule exists to
  // avoid, and is worse for the lead than a single clean call. The lead is
  // already scheduled two days out, so skipping costs nothing.
  const reserved =
    c.is_redial && c.redial_number_id
      ? await usableRedialNumber(supabase, c.campaign_id, c.redial_number_id)
      : null;
  if (c.is_redial && !reserved) return { callId: null };

  // Pick a healthy, under-cap, area-matched number from the campaign's pool.
  // Null → the whole pool is capped/rested right now: skip WITHOUT inserting a
  // call; the claim lease (2 min) makes the lead retry, and volume self-throttles
  // to what the pool can safely support.
  const picked =
    reserved ??
    (await selectPoolNumber(
      supabase,
      c.campaign_id,
      c.business_phone,
      c.lead_id, // stable spread key
    ));
```

and add `is_redial` to the `calls` insert:

```ts
    .insert({
      lead_id: c.lead_id,
      campaign_id: c.campaign_id,
      agent_id: c.agent_id,
      twilio_number_id: picked.numberId,
      direction: "outbound",
      status: "queued",
      outcome: null,
      outcome_source: "elevenlabs",
      is_redial: c.is_redial === true,
    })
```

- [ ] **Step 5: Import the helper**

At the top of `tick.ts`, add `usableRedialNumber` to the existing
`@/lib/dialer/number-pool` import.

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit && npx eslint src/lib/dialer/queue.ts src/lib/dialer/tick.ts && npx vitest run`
Expected: exit 0 on all three.

- [ ] **Step 7: Commit**

```bash
git add src/lib/dialer/queue.ts src/lib/dialer/tick.ts
git commit -m "feat(dialer): place the redial on the original number"
```

---

### Task 6: The campaign toggle

Mirrors `smart_scheduling`, which is the same shape (per-campaign boolean, checkbox in the settings dialog).

**Files:**

- Modify: `src/lib/campaigns/actions.ts`
- Modify: `src/app/(app)/campaigns/campaign-settings-dialog.tsx`
- Modify: `src/app/(app)/campaigns/page.tsx`

- [ ] **Step 1: Accept and persist the field**

In `src/lib/campaigns/actions.ts`, beside `smartSchedulingEnabled?: boolean;` (~line 91):

```ts
  doubleCallEnabled?: boolean;
```

and beside `smart_scheduling: input.smartSchedulingEnabled ?? false,` (~line 154):

```ts
    double_call_enabled: input.doubleCallEnabled ?? false,
```

- [ ] **Step 2: Add the checkbox**

In `campaign-settings-dialog.tsx`, add to the campaign prop type beside
`smart_scheduling: boolean;` (~line 81):

```ts
double_call_enabled: boolean;
```

add state beside `smartSchedulingEnabled` (~line 215):

```ts
const [doubleCallEnabled, setDoubleCallEnabled] = useState(
  campaign?.double_call_enabled ?? false,
);
```

add to the submit payload beside `smartSchedulingEnabled,` (~line 321):

```ts
        doubleCallEnabled,
```

and render the control directly after the smart-scheduling `</label>` (~line 707):

```tsx
<label
  htmlFor="campaign-double-call"
  className="border-border hover:bg-muted/40 flex cursor-pointer items-start gap-3 rounded-lg border p-3"
>
  <Checkbox
    id="campaign-double-call"
    checked={doubleCallEnabled}
    onCheckedChange={(v) => setDoubleCallEnabled(v === true)}
    className="mt-0.5"
  />
  <div className="flex flex-col gap-0.5">
    <span className="text-foreground text-sm font-medium">
      Double call on voicemail
    </span>
    <span className="text-muted-foreground text-xs">
      When a call reaches voicemail, ring the same number again about 30 seconds
      later, so the lead sees two missed calls rather than one. Applies to the
      first and last attempt of each retry cycle, not every call. Raises dials
      on unanswered leads by roughly two thirds — watch your connect rate under
      Settings → Twilio numbers.
    </span>
  </div>
</label>
```

- [ ] **Step 3: Select and pass the column**

In `src/app/(app)/campaigns/page.tsx`, add `double_call_enabled` to the select
string (~line 95, after `smart_scheduling`), then beside the existing
`smart_scheduling:` mappings (~lines 283 and 346):

```ts
    double_call_enabled:
      (c as { double_call_enabled?: boolean }).double_call_enabled ?? false,
```

```ts
      double_call_enabled: campaign.double_call_enabled,
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit && npx eslint src/lib/campaigns/actions.ts "src/app/(app)/campaigns/campaign-settings-dialog.tsx" "src/app/(app)/campaigns/page.tsx" && npm run build`
Expected: exit 0 on all three.

- [ ] **Step 5: Commit**

```bash
git add src/lib/campaigns/actions.ts "src/app/(app)/campaigns/campaign-settings-dialog.tsx" "src/app/(app)/campaigns/page.tsx"
git commit -m "feat(campaigns): double-call opt-in toggle"
```

---

### Task 7: End-to-end spec

Runs against the live database (this repo has no test DB). Follows the seed +
`afterAll` cleanup shape of `tests/number-daily-stats.spec.ts`.

**Files:**

- Create: `tests/double-call.spec.ts`

- [ ] **Step 1: Write the spec**

```ts
import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.describe.configure({ mode: "serial" });

/**
 * Double calling, end to end at the data layer: a voicemail on an opted-in
 * campaign leaves a redial marker, the queue surfaces it ahead of leads that are
 * merely due, and a stale marker is ignored.
 *
 * Placing real calls is out of scope — these assert the marker and the queue,
 * which is where the logic lives.
 */
test.describe("Double calling", () => {
  const stamp = Date.now();

  let admin: SupabaseClient;
  let ownerId: string;
  let listId: string;
  let leadId: string;
  let agentId: string;
  let goalId: string;
  let campaignId: string;
  let numberId: string;

  async function setDoubleCall(enabled: boolean) {
    await admin
      .from("campaigns")
      .update({ double_call_enabled: enabled })
      .eq("id", campaignId);
  }

  async function seedLead(patch: Record<string, unknown>) {
    await admin.from("leads").update(patch).eq("id", leadId);
  }

  /** Insert a finished call, then drive the retry engine the way
   *  tests/retry-engine.spec.ts does — through the ElevenLabs post-call webhook,
   *  which calls applyRetryForCall in its tail. */
  async function seedCallAndFire(
    conversationId: string,
    disposition: string,
  ): Promise<void> {
    await admin.from("calls").insert({
      lead_id: leadId,
      campaign_id: campaignId,
      agent_id: agentId,
      twilio_number_id: numberId,
      direction: "outbound",
      status: "completed",
      elevenlabs_conversation_id: conversationId,
    });
    const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
    const res = await fetch(`${baseUrl}/api/elevenlabs/post-call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conversation_id: conversationId,
        analysis: { data_collection: { disposition } },
      }),
    });
    expect(res.ok).toBe(true);
  }

  async function leadRow() {
    const { data } = await admin
      .from("leads")
      .select(
        "redial_at, redial_number_id, retry_position, retry_counter, next_call_at",
      )
      .eq("id", leadId)
      .single();
    return data;
  }

  async function queueRow() {
    const { data } = await admin
      .from("dial_queue")
      .select("lead_id, is_redial_due, redial_number_id")
      .eq("lead_id", leadId)
      .maybeSingle();
    return data;
  }

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

    const { data: list } = await admin
      .from("lists")
      .insert({ owner_id: ownerId, name: `E2E DC List ${stamp}` })
      .select("id")
      .single();
    listId = list!.id;

    const { data: agent } = await admin
      .from("agents")
      .insert({
        owner_id: ownerId,
        name: `E2E DC Agent ${stamp}`,
        elevenlabs_agent_id: `dc-agent-${stamp}`,
        prompt_personality: "x",
        prompt_environment: "x",
        prompt_tone: "x",
        prompt_goal: "x",
        prompt_guardrails: "x",
      })
      .select("id")
      .single();
    agentId = agent!.id;

    const { data: goal } = await admin
      .from("goals")
      .insert({ owner_id: ownerId, name: `E2E DC Goal ${stamp}` })
      .select("id")
      .single();
    goalId = goal!.id;

    const { data: campaign } = await admin
      .from("campaigns")
      .insert({
        owner_id: ownerId,
        name: `E2E DC Campaign ${stamp}`,
        status: "active",
        agent_id: agentId,
        goal_id: goalId,
        autopilot_enabled: true,
        calling_hours_start: "00:00:00",
        calling_hours_end: "23:59:59",
        double_call_enabled: true,
      })
      .select("id")
      .single();
    campaignId = campaign!.id;

    await admin
      .from("list_campaign_attachments")
      .insert({ campaign_id: campaignId, list_id: listId });

    // A pool number attached to the campaign, so the queue's pool gate passes.
    const { data: number } = await admin
      .from("twilio_numbers")
      .insert({
        phone_number: `+1558${Math.floor(Math.random() * 1e7)
          .toString()
          .padStart(7, "0")}`,
        friendly_name: `E2E DC Number ${stamp}`,
        country: "US",
        attached_campaign_id: campaignId,
        elevenlabs_phone_number_id: `phnum_dc_${stamp}`,
        pool_status: "active",
      })
      .select("id")
      .single();
    numberId = number!.id;

    const { data: lead } = await admin
      .from("leads")
      .insert({
        owner_id: ownerId,
        list_id: listId,
        company: `E2E DC Lead ${stamp}`,
        business_phone: `+1668${String(stamp).slice(-7)}`,
        timezone: "America/New_York",
        status: "ready_to_call",
      })
      .select("id")
      .single();
    leadId = lead!.id;
  });

  test.afterAll(async () => {
    await admin
      .from("calls")
      .delete()
      .eq("lead_id", leadId ?? "");
    await admin
      .from("leads")
      .delete()
      .eq("id", leadId ?? "");
    await admin
      .from("twilio_numbers")
      .delete()
      .eq("id", numberId ?? "");
    await admin
      .from("list_campaign_attachments")
      .delete()
      .eq("campaign_id", campaignId ?? "");
    await admin
      .from("campaigns")
      .delete()
      .eq("id", campaignId ?? "");
    await admin
      .from("agents")
      .delete()
      .eq("id", agentId ?? "");
    await admin
      .from("goals")
      .delete()
      .eq("id", goalId ?? "");
    await admin
      .from("lists")
      .delete()
      .eq("id", listId ?? "");
  });

  test("a voicemail on an opted-in campaign writes the marker", async () => {
    await setDoubleCall(true);
    await seedLead({
      status: "ready_to_call",
      retry_position: 0,
      redial_at: null,
      redial_number_id: null,
    });

    await seedCallAndFire(`dc-conv-in-${stamp}`, "voicemail");

    const lead = await leadRow();
    expect(lead?.redial_at).not.toBeNull();
    expect(lead?.redial_number_id).toBe(numberId);
    // The pair counts once: the cycle still advanced on call 1 (0 → 1).
    expect(lead?.retry_position).toBe(1);
  });

  test("the pair advances the retry cycle exactly once", async () => {
    // The expensive silent failure: without the is_redial skip, call 2 advances
    // again and overwrites call 1's schedule. At retry position 2 that turns a
    // 15-day cool-off into a 2-day one.
    await setDoubleCall(true);
    await seedLead({
      status: "ready_to_call",
      retry_position: 2,
      retry_counter: 0,
      redial_at: null,
      redial_number_id: null,
    });

    await seedCallAndFire(`dc-conv-p2a-${stamp}`, "voicemail");
    const afterFirst = await leadRow();
    expect(afterFirst?.retry_position).toBe(0); // 2 -> 0
    const scheduledAfterFirst = afterFirst?.next_call_at;

    // Call 2 of the pair, flagged as the redial.
    await admin.from("calls").insert({
      lead_id: leadId,
      campaign_id: campaignId,
      agent_id: agentId,
      twilio_number_id: numberId,
      direction: "outbound",
      status: "completed",
      is_redial: true,
      elevenlabs_conversation_id: `dc-conv-p2b-${stamp}`,
    });
    const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
    await fetch(`${baseUrl}/api/elevenlabs/post-call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conversation_id: `dc-conv-p2b-${stamp}`,
        analysis: { data_collection: { disposition: "voicemail" } },
      }),
    });

    const afterSecond = await leadRow();
    // Unchanged: the pair is ONE attempt.
    expect(afterSecond?.retry_position).toBe(0);
    expect(afterSecond?.next_call_at).toBe(scheduledAfterFirst);
    // And a redial never spawns another redial.
    expect(afterSecond?.redial_at).toBeNull();
  });

  test("a voicemail on an opted-OUT campaign writes nothing", async () => {
    await setDoubleCall(false);
    await seedLead({
      status: "ready_to_call",
      retry_position: 0,
      redial_at: null,
      redial_number_id: null,
    });

    await seedCallAndFire(`dc-conv-out-${stamp}`, "voicemail");

    const lead = await leadRow();
    expect(lead?.redial_at).toBeNull();
    expect(lead?.redial_number_id).toBeNull();
    expect(lead?.retry_position).toBe(1);
  });

  test("retry position 1 does not get doubled", async () => {
    await setDoubleCall(true);
    await seedLead({
      status: "ready_to_call",
      retry_position: 1,
      redial_at: null,
      redial_number_id: null,
    });

    await seedCallAndFire(`dc-conv-mid-${stamp}`, "voicemail");

    const lead = await leadRow();
    expect(lead?.redial_at).toBeNull();
    expect(lead?.retry_position).toBe(2);
  });

  test("a non-voicemail outcome never writes the marker", async () => {
    await setDoubleCall(true);
    await seedLead({
      status: "ready_to_call",
      retry_position: 0,
      redial_at: null,
      redial_number_id: null,
    });

    await seedCallAndFire(`dc-conv-na-${stamp}`, "no_answer");

    const lead = await leadRow();
    expect(lead?.redial_at).toBeNull();
  });

  test("a live marker surfaces the lead even though next_call_at is days out", async () => {
    await setDoubleCall(true);
    await seedLead({
      next_call_at: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      redial_at: new Date().toISOString(),
      redial_number_id: numberId,
    });

    const row = await queueRow();
    expect(row).not.toBeNull();
    expect(row?.is_redial_due).toBe(true);
    expect(row?.redial_number_id).toBe(numberId);
  });

  test("a marker older than 10 minutes is ignored", async () => {
    await seedLead({
      next_call_at: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      redial_at: new Date(Date.now() - 11 * 60_000).toISOString(),
      redial_number_id: numberId,
    });

    // next_call_at is in the future and the marker has expired, so the lead
    // should not be dialable at all.
    expect(await queueRow()).toBeNull();
  });

  test("a due lead carrying a stale marker is not treated as a redial", async () => {
    await seedLead({
      next_call_at: new Date(Date.now() - 60_000).toISOString(),
      redial_at: new Date(Date.now() - 11 * 60_000).toISOString(),
      redial_number_id: numberId,
    });

    const row = await queueRow();
    expect(row).not.toBeNull();
    // Surfaced on the normal clock — marking this is_redial would suppress its
    // cycle advance and silently stall the lead.
    expect(row?.is_redial_due).toBe(false);
  });

  test("clearing the marker returns the lead to the normal clock", async () => {
    await seedLead({
      next_call_at: new Date(Date.now() - 60_000).toISOString(),
      redial_at: null,
      redial_number_id: null,
    });

    const row = await queueRow();
    expect(row?.is_redial_due).toBe(false);
    expect(row?.redial_number_id).toBeNull();
  });
});
```

- [ ] **Step 2: Verify it typechecks and lints**

Run: `npx tsc --noEmit && npx eslint tests/double-call.spec.ts`
Expected: exit 0. (Playwright specs run against the live environment and are not
executed locally.)

- [ ] **Step 3: Commit**

```bash
git add tests/double-call.spec.ts
git commit -m "test(dialer): double-call marker and queue contract"
```

---

### Task 8: Ship

- [ ] **Step 1: Full verification**

```bash
npx tsc --noEmit && npx eslint . && npx vitest run && npm run build
```

Expected: exit 0 on all four; vitest reports the 6 new `redial-trigger` tests.

- [ ] **Step 2: Confirm every campaign is still opted out**

```bash
node -e '
require("dotenv").config({path:".env.local"});
const U=process.env.NEXT_PUBLIC_SUPABASE_URL, K=process.env.SUPABASE_SERVICE_ROLE_KEY;
(async()=>{
 const r=await fetch(U+"/rest/v1/campaigns?select=name,double_call_enabled",{headers:{apikey:K,Authorization:"Bearer "+K}});
 console.log(JSON.stringify(await r.json()));
})();
'
```

Expected: `double_call_enabled: false` on every row. The feature ships dark; Marija turns it on per campaign.

- [ ] **Step 3: Open the PR**

```bash
git push -u origin feat/double-call
gh pr create --title "Double calling: redial the same number after a voicemail"
```

Body must state: opt-in per campaign and off everywhere on merge; the migration
was applied to prod before merge (the queue view is read by the deployed tick);
the +67% dial increase on never-answering leads; and the recommendation to enable
on one campaign and watch the per-number connect-rate sparkline for a week.

- [ ] **Step 4: Merge**

```bash
gh pr merge --squash --delete-branch
```

---

## Out of scope

**Leads are called forever.** `retry_counter` only increments and no state marks
a lead exhausted, so a lead that never answers cycles 2d/2d/15d indefinitely.
Double calling makes that more expensive rather than newly broken. A separate
piece of work: a max-attempts setting, an exhausted lead state, and a decision
about leads already past that limit.
