# Local-match measurement & match-first dial ordering — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record which local-presence tier every outbound call was dialed on, and dial locally-matchable leads first (US before Canada), so the local-presence premise can be measured before any numbers are bought.

**Architecture:** A new `nanp_area_codes` reference table gives SQL the area-code → state/country map that currently only exists in TypeScript. `dial_queue` uses it to rank each cold lead by destination country and local-match tier, appended as two new sort keys that bind only on never-scheduled leads. `pickPoolNumber` starts returning the tier it already computes internally, and `tick.ts` stamps it onto the call row.

**Tech Stack:** Next.js (App Router), Supabase/Postgres, TypeScript, vitest.

**Critical constraint — this PR must not change which number gets picked.** It changes only lead _ordering_ and what gets _recorded_. If selection changed at the same time, the resulting connect-rate shift could not be attributed. `stateForAreaCode` therefore keeps returning `null` for Canadian area codes in this PR; extending it to provinces belongs to PR 2 (spec item A).

**Spec:** `docs/superpowers/specs/2026-07-28-connect-rate-number-management-design.md` (items D and G).

---

## File Structure

| File                                                            | Responsibility                                                                                                          |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `supabase/migrations/20260729120000_nanp_area_codes.sql`        | Create + seed the area-code → state/country reference table                                                             |
| `supabase/migrations/20260729120100_calls_local_match.sql`      | Add `calls.local_match` and `calls.dest_country`                                                                        |
| `supabase/migrations/20260729120200_dial_queue_local_match.sql` | Reproduce `dial_queue` in full, appending `dest_rank` + `local_match_rank` and the new ORDER BY                         |
| `scripts/gen-nanp-seed.mjs`                                     | One-shot generator that emits the seed SQL from the TS maps (kept so the table can be regenerated without hand-editing) |
| `src/lib/dialer/nanp-states.ts`                                 | Gains `CANADA_AREA_CODES` + `countryForAreaCode`. `stateForAreaCode` is **unchanged**.                                  |
| `src/lib/dialer/number-pool.ts`                                 | `pickPoolNumber` / `selectPoolNumber` return the match tier                                                             |
| `src/lib/dialer/tick.ts`                                        | Stamp `local_match` + `dest_country`; add the two new `.order()` calls                                                  |
| `src/lib/dialer/queue.ts`                                       | Add the same two `.order()` calls so the preview matches the dialer                                                     |
| `tests/number-pool.unit.test.ts`                                | Extend for the returned tier                                                                                            |
| `tests/nanp-country.unit.test.ts`                               | New — `countryForAreaCode`                                                                                              |

**Why a reference table rather than sorting in TypeScript:** `dial_queue` reads 50 rows out of ~9,475 due leads, so the ordering must happen in SQL. Sorting in JS would mean paginating the whole queue every minute.

---

### Task 1: `countryForAreaCode` in TypeScript

**Files:**

- Modify: `src/lib/dialer/nanp-states.ts`
- Test: `tests/nanp-country.unit.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/nanp-country.unit.test.ts`:

```ts
// tests/nanp-country.unit.test.ts
import { describe, it, expect } from "vitest";
import {
  countryForAreaCode,
  stateForAreaCode,
} from "../src/lib/dialer/nanp-states";

describe("countryForAreaCode", () => {
  it("identifies US geographic area codes", () => {
    expect(countryForAreaCode("954")).toBe("US");
    expect(countryForAreaCode("213")).toBe("US");
    expect(countryForAreaCode("732")).toBe("US");
  });

  it("identifies Canadian area codes", () => {
    expect(countryForAreaCode("902")).toBe("CA"); // Nova Scotia
    expect(countryForAreaCode("506")).toBe("CA"); // New Brunswick
    expect(countryForAreaCode("709")).toBe("CA"); // Newfoundland
    expect(countryForAreaCode("403")).toBe("CA"); // Calgary
    expect(countryForAreaCode("905")).toBe("CA"); // Greater Toronto
  });

  it("returns null for toll-free and unknown codes", () => {
    expect(countryForAreaCode("800")).toBeNull();
    expect(countryForAreaCode("888")).toBeNull();
    expect(countryForAreaCode(null)).toBeNull();
    expect(countryForAreaCode("")).toBeNull();
  });

  it("does NOT change stateForAreaCode for Canada in this PR", () => {
    // PR 2 extends this to provinces. Changing it here would alter which
    // number selectPoolNumber picks, which would confound the measurement.
    expect(stateForAreaCode("902")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/nanp-country.unit.test.ts
```

Expected: FAIL — `countryForAreaCode is not a function`.

- [ ] **Step 3: Implement**

Append to `src/lib/dialer/nanp-states.ts`:

```ts
/**
 * Canadian NANP area codes. Kept SEPARATE from `STATE_AREA_CODES` on purpose:
 * `stateForAreaCode` must keep returning null for these until PR 2, because
 * making it province-aware would change which number `pickPoolNumber` selects —
 * and this PR deliberately changes ordering and recording only, so the
 * connect-rate effect stays attributable.
 */
export const CANADA_AREA_CODES: ReadonlySet<string> = new Set([
  "204",
  "226",
  "236",
  "249",
  "250",
  "263",
  "289",
  "306",
  "343",
  "354",
  "365",
  "367",
  "368",
  "382",
  "387",
  "403",
  "416",
  "418",
  "428",
  "431",
  "437",
  "438",
  "450",
  "468",
  "474",
  "506",
  "514",
  "519",
  "548",
  "579",
  "581",
  "584",
  "587",
  "604",
  "613",
  "639",
  "647",
  "672",
  "683",
  "705",
  "709",
  "742",
  "753",
  "778",
  "780",
  "782",
  "807",
  "819",
  "825",
  "867",
  "873",
  "879",
  "902",
  "905",
]);

/** 'US' | 'CA' for a geographic NANP area code, else null (toll-free,
 *  premium, and other non-geographic codes have no destination country we
 *  can act on). */
export function countryForAreaCode(
  areaCode: string | null | undefined,
): "US" | "CA" | null {
  if (!areaCode) return null;
  if (stateForAreaCode(areaCode)) return "US";
  return CANADA_AREA_CODES.has(areaCode) ? "CA" : null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tests/nanp-country.unit.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/dialer/nanp-states.ts tests/nanp-country.unit.test.ts
git commit -m "feat(dialer): countryForAreaCode for US/Canada destination split"
```

---

### Task 2: `nanp_area_codes` reference table

**Files:**

- Create: `scripts/gen-nanp-seed.mjs`
- Create: `supabase/migrations/20260729120000_nanp_area_codes.sql`

- [ ] **Step 1: Write the generator**

Create `scripts/gen-nanp-seed.mjs`:

```js
// Emits the VALUES rows for the nanp_area_codes seed from the TypeScript maps,
// so SQL and TS can never drift by hand-editing. Run with:
//   npx tsx scripts/gen-nanp-seed.mjs
import {
  STATE_AREA_CODES,
  CANADA_AREA_CODES,
} from "../src/lib/dialer/nanp-states.ts";

const rows = [];
for (const [state, codes] of Object.entries(STATE_AREA_CODES)) {
  for (const c of codes) rows.push(`('${c}', '${state}', 'US')`);
}
for (const c of CANADA_AREA_CODES) rows.push(`('${c}', null, 'CA')`);

rows.sort();
console.log(rows.join(",\n"));
console.error(`-- ${rows.length} rows`);
```

- [ ] **Step 2: Run it and capture the output**

```bash
npx tsx scripts/gen-nanp-seed.mjs > /tmp/nanp-seed.sql
```

Expected: `/tmp/nanp-seed.sql` contains one `('###', 'XX', 'US')` or `('###', null, 'CA')` row per line, and stderr reports roughly 350–400 rows.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260729120000_nanp_area_codes.sql`. Paste the generated rows in place of the `-- <<GENERATED ROWS>>` marker:

```sql
-- NANP area code -> US state / country, so SQL can reason about local presence.
-- dial_queue needs this to rank leads by how local the campaign's available
-- numbers are to them; the map previously existed only in TypeScript
-- (src/lib/dialer/nanp-states.ts), which a view cannot call.
--
-- Regenerate with: npx tsx scripts/gen-nanp-seed.mjs
-- Canadian rows carry country='CA' and a null state (province-level matching
-- arrives with PR 2).

create table if not exists public.nanp_area_codes (
  area_code text primary key,
  state     text,
  country   text not null check (country in ('US', 'CA'))
);

comment on table public.nanp_area_codes is
  'NANP area code -> state (US only) and country. Reference data, generated '
  'from src/lib/dialer/nanp-states.ts by scripts/gen-nanp-seed.mjs. Read by '
  'dial_queue to rank leads by local-presence match. Non-geographic codes '
  '(toll-free, premium) are deliberately absent, so a lookup miss means '
  '"no destination geography we can act on".';

insert into public.nanp_area_codes (area_code, state, country) values
-- <<GENERATED ROWS>>
on conflict (area_code) do update
  set state = excluded.state,
      country = excluded.country;

alter table public.nanp_area_codes enable row level security;

-- Reference data: readable by any signed-in user, writable only by migrations
-- (service role bypasses RLS).
drop policy if exists nanp_area_codes_select on public.nanp_area_codes;
create policy nanp_area_codes_select on public.nanp_area_codes
  for select to authenticated using (true);

grant select on public.nanp_area_codes to authenticated;
```

- [ ] **Step 4: Apply to production and verify**

```bash
npx supabase db push --linked
```

Then verify the row count and three known codes:

```bash
npx tsx -e "
const k=require('fs').readFileSync('.env.local','utf8').match(/^SUPABASE_SERVICE_ROLE_KEY=(.*)\$/m)[1].trim();
const u='https://gpgmtmmmxasbadwjpdxf.supabase.co/rest/v1';
const h={apikey:k,Authorization:'Bearer '+k};
for (const q of ['area_code=eq.954','area_code=eq.902','area_code=eq.800'])
  console.log(q, await (await fetch(u+'/nanp_area_codes?select=*&'+q,{headers:h})).text());
"
```

Expected: `954` → `state: "FL", country: "US"`; `902` → `state: null, country: "CA"`; `800` → `[]`.

- [ ] **Step 5: Commit**

```bash
git add scripts/gen-nanp-seed.mjs supabase/migrations/20260729120000_nanp_area_codes.sql
git commit -m "feat(db): nanp_area_codes reference table for SQL-side local matching"
```

---

### Task 3: `calls.local_match` and `calls.dest_country`

**Files:**

- Create: `supabase/migrations/20260729120100_calls_local_match.sql`
- Modify: `src/lib/supabase/database.types.ts`

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260729120100_calls_local_match.sql`:

```sql
-- Record, per outbound call, how local the caller ID was to the lead and which
-- country we dialled. Both are stamped at placement by the dialer from the tier
-- pickPoolNumber already chose, so they record what actually happened rather
-- than re-deriving it later from a lead's phone (which can change).
--
-- Nullable and additive: existing rows stay null, nothing reads them yet.
-- The Reporting "Numbers" tab (Phase 2) and the health monitor (PR 3) are the
-- consumers.

alter table public.calls
  add column if not exists local_match  text,
  add column if not exists dest_country text;

alter table public.calls
  drop constraint if exists calls_local_match_check;
alter table public.calls
  add constraint calls_local_match_check
  check (local_match is null or local_match in ('exact', 'state', 'none'));

alter table public.calls
  drop constraint if exists calls_dest_country_check;
alter table public.calls
  add constraint calls_dest_country_check
  check (dest_country is null or dest_country in ('US', 'CA'));

comment on column public.calls.local_match is
  'Local-presence tier the caller ID had for this lead at placement: exact '
  '(same area code), state (same US state), none. Null for inbound, human '
  'browser dials, and every call placed before 2026-07-29.';
comment on column public.calls.dest_country is
  'Destination country derived from the lead area code at placement: US or CA. '
  'Null when the number is non-geographic (toll-free) or pre-dates this column.';

-- Reporting reads these grouped by number and by day.
create index if not exists calls_local_match_idx
  on public.calls (local_match) where local_match is not null;
create index if not exists calls_dest_country_idx
  on public.calls (dest_country) where dest_country is not null;
```

- [ ] **Step 2: Apply to production**

```bash
npx supabase db push --linked
```

Expected: applies cleanly. This is additive-only — no existing read path references either column, so a deploy gap is safe in both directions.

- [ ] **Step 3: Regenerate the typed schema**

```bash
npx supabase gen types typescript --linked > src/lib/supabase/database.types.ts
```

- [ ] **Step 4: Verify the types compile**

```bash
npx tsc --noEmit
```

Expected: clean. If the generator reorders unrelated parts of the file, that is expected — review the diff for `local_match` / `dest_country` appearing in the `calls` Row/Insert/Update types.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260729120100_calls_local_match.sql src/lib/supabase/database.types.ts
git commit -m "feat(db): record local_match and dest_country on calls"
```

---

### Task 4: `pickPoolNumber` returns the tier it chose

**Files:**

- Modify: `src/lib/dialer/number-pool.ts`
- Test: `tests/number-pool.unit.test.ts`

The tier is already decided inside `pickPoolNumber` (which of `exact` / `sameState` / `underCap` won) and then discarded. Return it instead of recomputing it in the caller.

- [ ] **Step 1: Write the failing test**

Append to `tests/number-pool.unit.test.ts`:

```ts
describe("pickPoolNumber match tier", () => {
  it("reports 'exact' when the area code matches", () => {
    const picked = pickPoolNumber(
      [cand({ id: "a", areaCode: "954" }), cand({ id: "b", areaCode: "213" })],
      "954",
      "seed",
    );
    expect(picked?.id).toBe("a");
    expect(picked?.matchTier).toBe("exact");
  });

  it("reports 'state' when only a same-state number is available", () => {
    // 754 is Florida, same state as the 954 lead, different area code.
    const picked = pickPoolNumber(
      [cand({ id: "a", areaCode: "754" }), cand({ id: "b", areaCode: "213" })],
      "954",
      "seed",
    );
    expect(picked?.id).toBe("a");
    expect(picked?.matchTier).toBe("state");
  });

  it("reports 'none' when nothing is local", () => {
    const picked = pickPoolNumber(
      [cand({ id: "b", areaCode: "213" })],
      "954",
      "seed",
    );
    expect(picked?.id).toBe("b");
    expect(picked?.matchTier).toBe("none");
  });

  it("reports 'none' when the lead area code is unknown", () => {
    const picked = pickPoolNumber(
      [cand({ id: "b", areaCode: "213" })],
      null,
      "seed",
    );
    expect(picked?.matchTier).toBe("none");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/number-pool.unit.test.ts
```

Expected: FAIL — `matchTier` does not exist on the returned type.

- [ ] **Step 3: Implement**

In `src/lib/dialer/number-pool.ts`, add the type and change `pickPoolNumber`'s return. Replace the `return [...tier].sort(...)` tail:

```ts
/** How local the chosen caller ID is to the lead. Mirrors calls.local_match. */
export type MatchTier = "exact" | "state" | "none";

export type PickedPoolNumber = PoolCandidate & { matchTier: MatchTier };
```

and inside `pickPoolNumber`, after `const tier = ...`:

```ts
const matchTier: MatchTier =
  exact.length > 0 ? "exact" : sameState.length > 0 ? "state" : "none";

const hash = (s: string): number =>
  s.split("").reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
const chosen = [...tier].sort(
  (a, b) =>
    a.calls24h - b.calls24h ||
    (b.connectRate ?? -1) - (a.connectRate ?? -1) ||
    hash(spreadKey + a.id) - hash(spreadKey + b.id),
)[0];
return { ...chosen, matchTier };
```

Update the signature to `): PickedPoolNumber | null {`.

Then in `selectPoolNumber`, widen the return and pass the tier through:

```ts
): Promise<{
  numberId: string;
  elevenlabsPhoneNumberId: string;
  matchTier: MatchTier;
} | null> {
```

and the final return:

```ts
return chosen
  ? {
      numberId: chosen.id,
      elevenlabsPhoneNumberId: chosen.elevenlabsPhoneNumberId,
      matchTier: chosen.matchTier,
    }
  : null;
```

Finally, `usableRedialNumber` must return the same shape so `reserved ?? picked` stays a single type. A redial reuses call 1's number regardless of locality, so recompute the tier honestly from that number's area code:

```ts
export async function usableRedialNumber(
  db: Admin,
  campaignId: string,
  numberId: string,
  leadPhone: string | null,
): Promise<{
  numberId: string;
  elevenlabsPhoneNumberId: string;
  matchTier: MatchTier;
} | null> {
```

Add `area_code` to that function's `.select(...)` (it currently selects only `id, elevenlabs_phone_number_id`) and compute:

```ts
const leadAc = areaCodeOf(leadPhone);
const leadState = stateForAreaCode(leadAc);
const numState = stateForAreaCode(data.area_code);
const matchTier: MatchTier =
  leadAc && data.area_code === leadAc
    ? "exact"
    : leadState && numState === leadState
      ? "state"
      : "none";
return {
  numberId: data.id,
  elevenlabsPhoneNumberId: data.elevenlabs_phone_number_id,
  matchTier,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run tests/number-pool.unit.test.ts
```

Expected: PASS — all pre-existing pool tests plus the 4 new ones. The existing tests assert `picked?.id`, which is unaffected by the added field.

- [ ] **Step 5: Commit**

```bash
git add src/lib/dialer/number-pool.ts tests/number-pool.unit.test.ts
git commit -m "feat(dialer): pickPoolNumber returns the local-match tier it chose"
```

---

### Task 5: Stamp the tier onto the call row

**Files:**

- Modify: `src/lib/dialer/tick.ts:511-552`

- [ ] **Step 1: Pass the lead phone to `usableRedialNumber`**

At `src/lib/dialer/tick.ts:513`, add the fourth argument:

```ts
      ? await usableRedialNumber(
          supabase,
          c.campaign_id,
          c.redial_number_id,
          c.business_phone,
        )
```

- [ ] **Step 2: Stamp both columns on the insert**

In the `.from("calls").insert({...})` at `src/lib/dialer/tick.ts:539`, add two fields after `twilio_number_id`:

```ts
      twilio_number_id: picked.numberId,
      // Local-presence tier this caller ID had for this lead, recorded at
      // placement rather than re-derived later (a lead's phone can change).
      local_match: picked.matchTier,
      dest_country: countryForAreaCode(areaCodeOf(c.business_phone)),
```

- [ ] **Step 3: Add the imports**

At the top of `src/lib/dialer/tick.ts`, extend the existing number-pool import and add the NANP one:

```ts
import {
  areaCodeOf,
  selectPoolNumber,
  usableRedialNumber,
} from "@/lib/dialer/number-pool";
import { countryForAreaCode } from "@/lib/dialer/nanp-states";
```

- [ ] **Step 4: Verify it compiles**

```bash
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/dialer/tick.ts
git commit -m "feat(dialer): stamp local_match and dest_country at placement"
```

---

### Task 6: `dial_queue` ranks cold leads by country then local match

**Files:**

- Create: `supabase/migrations/20260729120200_dial_queue_local_match.sql`

**Read this before writing the migration.** `create or replace view` replaces the whole object, so the migration must reproduce the _entire_ current definition from `supabase/migrations/20260728200000_double_call_toggle_stops_pending_redials.sql` — every DOUBLE CALL and TOGGLE branch and comment included — plus the additions below. A partial replace silently deletes every column and branch it doesn't repeat. Postgres also forbids renaming or reordering existing output columns (42P16), so `dest_rank` and `local_match_rank` must be **appended after `queue_order`**.

- [ ] **Step 1: Copy the current definition**

```bash
sed -n '/^create or replace view public.dial_queue/,/^grant select on public.dial_queue to authenticated;/p' \
  supabase/migrations/20260728200000_double_call_toggle_stops_pending_redials.sql \
  > supabase/migrations/20260729120200_dial_queue_local_match.sql
```

- [ ] **Step 2: Add a header explaining the change and the obligation**

Prepend to the new migration:

```sql
-- ---------------------------------------------------------------------------
-- dial_queue: rank cold leads by how local the campaign's available numbers
-- are to them, and put US ahead of Canada.
--
-- Reproduced verbatim from 20260728200000_double_call_toggle_stops_pending_redials.sql
-- with exactly two kinds of addition, each marked -- LOCAL MATCH below:
--   1. a left join to public.nanp_area_codes for the LEAD's geography, plus two
--      new output columns dest_rank and local_match_rank (appended last -- see
--      the 42P16 note above the column list);
--   2. two new trailing ORDER BY keys.
--
-- WHY THE NEW KEYS SIT AFTER `queue_order nulls first` AND NOT BEFORE:
-- a lead that has never been scheduled has next_call_at null, so queue_order is
-- null, so EVERY never-called lead ties on that key -- which makes the two new
-- keys the effective sort for exactly the first-call population this is meant
-- to reorder. Rows that already carry a timestamp (retries, callbacks, and cold
-- leads that pre_call_check bumped by 5 minutes) keep their existing
-- time-ordered position, with the new keys acting only as a rare tiebreak.
-- Putting the new keys BEFORE queue_order would instead reorder retries and
-- drag matched leads repeatedly ahead of unmatched ones.
--
-- OBLIGATION FOR THE NEXT CHANGE: unchanged from the previous migration --
-- whoever next modifies dial_queue must reproduce this ENTIRE definition,
-- including the LOCAL MATCH additions, copied from the latest migration that
-- defines it.
-- ---------------------------------------------------------------------------
```

- [ ] **Step 3: Add the lead-geography join**

In the inner query's FROM clause, immediately after the `join public.campaigns c on ...` block and before the `where`, add:

```sql
  -- LOCAL MATCH: the LEAD's geography. Left join so a lead whose phone is not a
  -- parseable +1 NANP number (or is toll-free, which the table deliberately
  -- omits) still appears -- it simply ranks as non-US with no local match.
  left join public.nanp_area_codes nl
    on nl.area_code = substring(l.business_phone from 3 for 3)
```

- [ ] **Step 4: Add the two output columns**

In the inner `select`, after the `dial_priority` line, add:

```sql
,
    -- LOCAL MATCH: 0 = United States, 1 = Canada or unparseable. Country
    -- outranks the match tier so buying Canadian numbers can never promote
    -- Canadian leads ahead of US ones.
    (case when nl.country = 'US' then 0 else 1 end) as dest_rank,
    -- LOCAL MATCH: 0 = the campaign has a dialable number in this lead's own
    -- area code, 1 = one in the same state, 2 = neither. The availability test
    -- mirrors selectPoolNumber's gates INCLUDING rested_until, so a resting
    -- number cannot pull its leads to the front of the queue.
    (case
       when exists (
         select 1 from public.twilio_numbers tn
          where tn.attached_campaign_id = c.id
            and tn.released_at is null
            and tn.pool_status = 'active'
            and tn.flagged_for_rotation = false
            and tn.elevenlabs_phone_number_id is not null
            and (tn.rested_until is null or tn.rested_until <= now())
            and tn.area_code = nl.area_code
       ) then 0
       when nl.state is not null and exists (
         select 1 from public.twilio_numbers tn
           join public.nanp_area_codes na on na.area_code = tn.area_code
          where tn.attached_campaign_id = c.id
            and tn.released_at is null
            and tn.pool_status = 'active'
            and tn.flagged_for_rotation = false
            and tn.elevenlabs_phone_number_id is not null
            and (tn.rested_until is null or tn.rested_until <= now())
            and na.state = nl.state
       ) then 1
       else 2
     end) as local_match_rank
```

And in the OUTER select's column list, after `q.queue_order`, add:

```sql
,
  -- LOCAL MATCH: appended last -- create or replace view cannot reorder or
  -- rename the 19 columns above (Postgres 42P16).
  q.dest_rank,
  q.local_match_rank
```

- [ ] **Step 5: Replace the ORDER BY**

Replace the final `order by` line with:

```sql
-- LOCAL MATCH: two keys appended. See the header for why they sit after
-- queue_order rather than before it.
order by
  q.dial_priority,
  q.is_redial_due desc,
  q.queue_order nulls first,
  q.dest_rank,
  q.local_match_rank;
```

- [ ] **Step 6: Update the view comment**

Append to the `comment on view public.dial_queue is` string, before the closing `'Re-check caps in code.'`:

```
  'Among never-scheduled leads (queue_order null, so all tied), dest_rank puts '
  'US ahead of Canada and local_match_rank puts leads whose area code or state '
  'the campaign can dial locally ahead of the rest. '
```

- [ ] **Step 7: Apply and verify the ordering is real**

```bash
npx supabase db push --linked
```

Then confirm the new columns exist and that matched leads sort first:

```bash
npx tsx -e "
const k=require('fs').readFileSync('.env.local','utf8').match(/^SUPABASE_SERVICE_ROLE_KEY=(.*)\$/m)[1].trim();
const u='https://gpgmtmmmxasbadwjpdxf.supabase.co/rest/v1';
const h={apikey:k,Authorization:'Bearer '+k};
const r=await (await fetch(u+'/dial_queue?select=lead_id,dest_rank,local_match_rank,queue_order&limit=30',{headers:h})).json();
console.log(r.slice(0,30).map(x=>\`\${x.dest_rank} \${x.local_match_rank} \${x.queue_order??'null'}\`).join('\n'));
"
```

Expected: rows come back ordered with `dest_rank` 0 before 1 and `local_match_rank` ascending within that, among rows whose `queue_order` is null. If the queue is empty because it is outside calling hours, re-run during the window or accept the column check alone.

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/20260729120200_dial_queue_local_match.sql
git commit -m "feat(db): dial_queue ranks cold leads US-first then by local match"
```

---

### Task 7: Make the dialer actually honor the new ordering

**Files:**

- Modify: `src/lib/dialer/tick.ts:292-295`
- Modify: `src/lib/dialer/queue.ts:62`

**This is the step that makes Task 6 do anything.** PostgREST applies the client's `.order()` calls _instead of_ the view's ORDER BY, so without this the new keys are inert.

- [ ] **Step 1: Add the two keys in `tick.ts`**

Replace the `.order(...)` chain at `src/lib/dialer/tick.ts:292-294` with:

```ts
    .order("dial_priority", { ascending: true })
    .order("is_redial_due", { ascending: false })
    .order("queue_order", { ascending: true, nullsFirst: true })
    // LOCAL MATCH: never-scheduled leads all tie on queue_order (null), so
    // these two are what actually order the first-call population — US before
    // Canada, then exact area code before same-state before neither. PostgREST
    // applies THESE orders in place of the view's own ORDER BY, so omitting
    // them here silently disables the ranking the view computes.
    .order("dest_rank", { ascending: true })
    .order("local_match_rank", { ascending: true })
    .limit(options.limit ?? 50);
```

- [ ] **Step 2: Add the same keys in `queue.ts`**

So the operator-facing preview shows the same order the dialer will use. `readDialQueue` is a deliberate copy of the tick's inline query and its own header comment requires both to be updated together. At `src/lib/dialer/queue.ts:69`, immediately after `.order("queue_order", { ascending: true, nullsFirst: true })` and before `.limit(limit)`, add:

```ts
    .order("dest_rank", { ascending: true })
    .order("local_match_rank", { ascending: true })
```

- [ ] **Step 3: Verify**

```bash
npx tsc --noEmit && npx eslint src/lib/dialer/tick.ts src/lib/dialer/queue.ts src/lib/dialer/number-pool.ts src/lib/dialer/nanp-states.ts
```

Expected: both clean.

- [ ] **Step 4: Commit**

```bash
git add src/lib/dialer/tick.ts src/lib/dialer/queue.ts
git commit -m "feat(dialer): order the queue by destination country and local match"
```

---

### Task 8: Full verification and PR

- [ ] **Step 1: Run the whole local gate**

```bash
npx tsc --noEmit && npx eslint . && npx vitest run && npm run build
```

Expected: all four clean. There is no CI gate on this repo, so this is the gate.

- [ ] **Step 2: Confirm the dialer still places calls**

Fire one tick during calling hours and read the summary:

```bash
npx tsx -e "
const k=require('fs').readFileSync('.env.local','utf8').match(/^SUPABASE_SERVICE_ROLE_KEY=(.*)\$/m)[1].trim();
const u='https://gpgmtmmmxasbadwjpdxf.supabase.co/rest/v1';
const h={apikey:k,Authorization:'Bearer '+k};
const s=await (await fetch(u+'/app_settings?select=dialer_tick_secret',{headers:h})).json();
console.log('secret loaded:', Boolean(s[0]?.dialer_tick_secret));
"
```

Then POST `/api/dialer/tick` with the `x-dialer-secret` header set to that value against production, and confirm `dialed > 0` and `blockedReasons` contains no new reason. **Do this with Marija present** — it places real calls.

- [ ] **Step 3: Confirm the stamping works**

```bash
npx tsx -e "
const k=require('fs').readFileSync('.env.local','utf8').match(/^SUPABASE_SERVICE_ROLE_KEY=(.*)\$/m)[1].trim();
const u='https://gpgmtmmmxasbadwjpdxf.supabase.co/rest/v1';
const h={apikey:k,Authorization:'Bearer '+k};
const r=await (await fetch(u+'/calls?select=local_match,dest_country,started_at&direction=eq.outbound&order=started_at.desc&limit=10',{headers:h})).json();
console.table(r);
"
```

Expected: the newest rows carry non-null `local_match` and `dest_country`. Rows placed before the deploy stay null.

- [ ] **Step 4: Open the PR**

```bash
gh pr create --title "feat(dialer): measure local presence and dial matchable leads first" --body "$(cat <<'BODY'
## What

PR 1 of the connect-rate work (spec items D and G). Records how local each
outbound caller ID was to the lead, and dials locally-matchable leads first,
US before Canada.

## Migrations (apply in this order)

1. `20260729120000_nanp_area_codes.sql` — area code → state/country reference
   table, generated from `src/lib/dialer/nanp-states.ts`. SQL previously had no
   access to this map.
2. `20260729120100_calls_local_match.sql` — nullable `calls.local_match`
   (`exact`/`state`/`none`) and `calls.dest_country` (`US`/`CA`).
3. `20260729120200_dial_queue_local_match.sql` — reproduces `dial_queue` in full
   (required: `create or replace view` replaces the whole object) and appends
   `dest_rank` + `local_match_rank` plus two trailing ORDER BY keys.

All three are additive. Deploy order is safe in both directions.

## Two things worth reviewing closely

**Number selection is deliberately unchanged.** `stateForAreaCode` still returns
null for Canadian area codes. If this PR also changed which number gets picked,
the resulting connect-rate movement could not be attributed to the ordering
change. PR 2 extends the map.

**The new ORDER BY keys sit AFTER `queue_order nulls first`, not before.** Every
never-scheduled lead has `next_call_at` null, so they all tie on `queue_order` —
which makes the new keys the effective sort for exactly the first-call
population this targets, while retries and callbacks keep their time-ordered
position. Putting them earlier would reorder retries and let matched leads cycle
repeatedly ahead of unmatched ones.

PostgREST applies the client's `.order()` calls instead of the view's own ORDER
BY, so the ranking is inert until both call sites (`tick.ts` and `queue.ts`) pass
the new keys. That is why a view-only change would have looked correct and done
nothing.

## Expected observable outcome

- Share of outbound calls with `local_match` in (`exact`, `state`) climbs from
  ~1% toward the 15.7% ceiling the current three numbers allow.
- Canadian calls stop dominating the opening hour (they were 83% of the first 90
  calls each day).
- Connect rate by `local_match` becomes readable — which is the checkpoint that
  decides whether the number-buying work in PR 2 is worth doing.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```

---

## Rollout note

Deploy order is safe in either direction. The three migrations are additive: `nanp_area_codes` is new, the two `calls` columns are nullable, and the `dial_queue` change only appends columns. The old deployed dialer ignores all of it; the new one degrades to today's ordering if the view is somehow stale.

**The one thing to watch after deploy:** `local_match_rank` mirrors `selectPoolNumber`'s gates _including_ `rested_until`, but the view's existing pool gate does not check `rested_until`. That mismatch predates this change (a lead can be queued when every number is resting, then hit `pool_exhausted` at placement). This PR does not fix it — noted so the next person doesn't read the new rested check as the cause.

## What this PR deliberately does not do

- Change which number `selectPoolNumber` picks. `stateForAreaCode` still returns `null` for Canadian area codes; PR 2 extends it.
- Add the metro tier. That lands with PR 2 alongside fallback buying.
- Touch the retry cadence, calling hours, the mobile lock, or per-number caps.
