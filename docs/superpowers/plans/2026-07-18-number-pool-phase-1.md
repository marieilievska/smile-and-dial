# Number Pool — Phase 1 (migration + selection core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a campaign dial from a **pool** of its own numbers — picking a healthy, under-cap number that matches the lead's area code when possible — instead of one fixed number, while staying fully backward compatible.

**Architecture:** Reuse `twilio_numbers.attached_campaign_id` as pool membership. At placement time the dialer calls a new `selectPoolNumber()` that ranks the campaign's numbers (exact-area-code match first, then least-used under a warm-up-adjusted daily cap) and dials from the winner. `pre_call_check` and the `dial_queue` view switch from "campaign has a number" to "campaign has ≥1 usable pool number". Selection ranking is a **pure, unit-tested** function; the DB glue is thin.

**Tech Stack:** Next.js (App Router) server libs, Supabase Postgres (SQL migrations + RPC), TypeScript, Vitest for pure-unit tests.

**Scope of Phase 1 (explicitly):** exact-area-code match → any-least-used fallback (same-state "Tier B" and the health/warm-up **cron** are Phase 2; the warm-up _cap math_ is included here since selection needs it). Provisioning/UI is Phase 3. Backward compatible: an existing campaign's single attached number is simply a pool of 1.

**Deviations from the spec (intentional, noted):** `region` is **derived in code** from `area_code` (via the NANP map, Phase 2) rather than stored — so no `region` column and no 300-row SQL backfill in Phase 1. Pool tunables live in one `app_settings.number_pool_settings` jsonb (cleaner than 8 columns; matches `best_time_heatmap`).

---

## File structure

| File                                                               | Responsibility                                                                                                              |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `supabase/migrations/20260718150000_number_pool_schema.sql` (new)  | `twilio_numbers` pool columns + indexes; `app_settings.number_pool_settings` jsonb; backfill; `pool_number_usage_24h` RPC.  |
| `src/lib/dialer/number-pool.ts` (new)                              | Pure: `areaCodeOf`, `effectiveDailyCap`, `pickPoolNumber`. I/O: `loadPoolSettings`, `selectPoolNumber`. One focused module. |
| `tests/number-pool.unit.test.ts` (new)                             | Vitest units for the three pure functions.                                                                                  |
| `src/lib/dialer/tick.ts` (modify)                                  | `placeLiveDialerCall` selects the pool number at placement, records it on the `calls` row, defers on exhaustion.            |
| `supabase/migrations/20260718150100_pre_call_check_pool.sql` (new) | Re-declare `pre_call_check`: validate "≥1 usable pool number".                                                              |
| `supabase/migrations/20260718150200_dial_queue_pool.sql` (new)     | Re-declare `dial_queue`: pool-existence filter; drop the single-number projection.                                          |
| `src/lib/supabase/database.types.ts` (regenerate)                  | Pick up new columns.                                                                                                        |

---

## Task 1: Migration — pool schema, settings, usage RPC

**Files:**

- Create: `supabase/migrations/20260718150000_number_pool_schema.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Number pool (Phase 1): columns to support a per-campaign pool of numbers with
-- per-number daily caps, warm-up, and temporary rest. Additive + backward
-- compatible: an existing campaign's single attached number becomes a pool of 1.

alter table public.twilio_numbers
  add column if not exists area_code text,
  add column if not exists pool_status text not null default 'active',
  add column if not exists rested_until timestamptz,
  add column if not exists warmup_started_at timestamptz,
  add column if not exists daily_cap_override int;

alter table public.twilio_numbers
  drop constraint if exists twilio_numbers_pool_status_check;
alter table public.twilio_numbers
  add constraint twilio_numbers_pool_status_check
  check (pool_status in ('active', 'retired'));

-- Backfill: area code from the E.164 number; warm-up anchored at purchase (so
-- existing numbers are already "warm", full cap immediately).
update public.twilio_numbers
   set area_code = substring(phone_number from '^\+1(\d{3})')
 where area_code is null and phone_number ~ '^\+1\d{10}$';
update public.twilio_numbers
   set warmup_started_at = coalesce(warmup_started_at, purchased_at);

create index if not exists twilio_numbers_pool_idx
  on public.twilio_numbers (attached_campaign_id, pool_status);
create index if not exists twilio_numbers_pool_area_idx
  on public.twilio_numbers (attached_campaign_id, area_code);

-- Single-row config blob (mirrors best_time_heatmap). Defaults chosen for
-- reputation-safe high-volume dialing.
alter table public.app_settings
  add column if not exists number_pool_settings jsonb not null
  default '{"daily_cap":100,"warmup_days":14,"warmup_start_cap":20}'::jsonb;

-- Accurate per-number 24h usage for a campaign's pool, grouped server-side so it
-- never hits PostgREST's 1,000-row response cap. Mirrors pre_call_check's cap
-- counting (AI outbound, not-failed).
create or replace function public.pool_number_usage_24h(in_campaign_id uuid)
returns table (twilio_number_id uuid, calls_24h bigint)
language sql
stable
security definer
set search_path = public
as $$
  select c.twilio_number_id, count(*)
    from public.calls c
   where c.campaign_id = in_campaign_id
     and c.direction = 'outbound'
     and c.call_mode = 'ai'
     and c.status <> 'failed'
     and c.twilio_number_id is not null
     and c.created_at >= now() - interval '24 hours'
   group by c.twilio_number_id;
$$;

comment on function public.pool_number_usage_24h is
  'Per-number outbound-AI call count over the trailing 24h for a campaign''s '
  'pool, grouped in SQL to dodge the 1,000-row cap. Used by selectPoolNumber '
  'to enforce per-number daily caps.';
```

- [ ] **Step 2: Apply to the live DB**

Run: `supabase db push --linked`
Expected: migration applies cleanly; `twilio_numbers` gains the columns; existing
rows get `area_code` + `warmup_started_at` backfilled; `pool_number_usage_24h`
exists. (This hits the LIVE prod DB — additive only, no drops; safe.)

- [ ] **Step 3: Sanity-check the backfill**

Run (adjust to your query tool):

```sql
select count(*) filter (where area_code is not null) as with_area,
       count(*) as total from public.twilio_numbers;
```

Expected: `with_area == total` for US (+1) numbers.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260718150000_number_pool_schema.sql
git commit -m "feat(pool): number-pool schema, settings, and 24h-usage RPC"
```

---

## Task 2: Pure selection helpers + unit tests

**Files:**

- Create: `src/lib/dialer/number-pool.ts`
- Test: `tests/number-pool.unit.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/number-pool.unit.test.ts
import { describe, it, expect } from "vitest";
import {
  areaCodeOf,
  effectiveDailyCap,
  pickPoolNumber,
  type PoolCandidate,
} from "../src/lib/dialer/number-pool";

const DAY = 86_400_000;
const NOW = 1_760_000_000_000; // fixed clock

function cand(p: Partial<PoolCandidate>): PoolCandidate {
  return {
    id: "n1",
    elevenlabsPhoneNumberId: "phnum_1",
    areaCode: "954",
    calls24h: 0,
    effectiveCap: 100,
    connectRate: null,
    ...p,
  };
}

describe("areaCodeOf", () => {
  it("parses a US E.164 number", () => {
    expect(areaCodeOf("+19543357483")).toBe("954");
  });
  it("returns null for non-US / malformed", () => {
    expect(areaCodeOf("+447911123456")).toBeNull();
    expect(areaCodeOf("")).toBeNull();
    expect(areaCodeOf(null)).toBeNull();
  });
});

describe("effectiveDailyCap (warm-up ramp)", () => {
  const base = { matureCap: 100, warmupStartCap: 20, warmupDays: 14, now: NOW };
  it("returns the mature cap once warm-up is over", () => {
    expect(
      effectiveDailyCap({
        ...base,
        warmupStartedAt: new Date(NOW - 20 * DAY).toISOString(),
      }),
    ).toBe(100);
  });
  it("returns the start cap on day 0", () => {
    expect(
      effectiveDailyCap({
        ...base,
        warmupStartedAt: new Date(NOW).toISOString(),
      }),
    ).toBe(20);
  });
  it("ramps linearly at the halfway point", () => {
    // day 7 of 14 → 20 + (100-20)*0.5 = 60
    expect(
      effectiveDailyCap({
        ...base,
        warmupStartedAt: new Date(NOW - 7 * DAY).toISOString(),
      }),
    ).toBe(60);
  });
  it("treats a null warm-up start as mature", () => {
    expect(effectiveDailyCap({ ...base, warmupStartedAt: null })).toBe(100);
  });
});

describe("pickPoolNumber", () => {
  it("prefers an exact area-code match over a less-used other-area number", () => {
    const chosen = pickPoolNumber(
      [
        cand({ id: "other", areaCode: "212", calls24h: 0 }),
        cand({ id: "local", areaCode: "954", calls24h: 30 }),
      ],
      "954",
      "leadA",
    );
    expect(chosen?.id).toBe("local");
  });
  it("falls back to any least-used when no area-code match", () => {
    const chosen = pickPoolNumber(
      [
        cand({ id: "a", areaCode: "212", calls24h: 40 }),
        cand({ id: "b", areaCode: "305", calls24h: 10 }),
      ],
      "954",
      "leadA",
    );
    expect(chosen?.id).toBe("b");
  });
  it("excludes numbers at or over their effective cap", () => {
    const chosen = pickPoolNumber(
      [
        cand({ id: "full", areaCode: "954", calls24h: 100, effectiveCap: 100 }),
        cand({ id: "ok", areaCode: "305", calls24h: 5, effectiveCap: 100 }),
      ],
      "954",
      "leadA",
    );
    expect(chosen?.id).toBe("ok");
  });
  it("returns null when every number is capped (pool exhausted)", () => {
    const chosen = pickPoolNumber(
      [cand({ id: "x", calls24h: 100, effectiveCap: 100 })],
      "954",
      "leadA",
    );
    expect(chosen).toBeNull();
  });
  it("breaks a usage tie by higher connect rate", () => {
    const chosen = pickPoolNumber(
      [
        cand({ id: "low", areaCode: "954", calls24h: 10, connectRate: 0.1 }),
        cand({ id: "high", areaCode: "954", calls24h: 10, connectRate: 0.3 }),
      ],
      "954",
      "leadA",
    );
    expect(chosen?.id).toBe("high");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/number-pool.unit.test.ts`
Expected: FAIL — `number-pool.ts` doesn't exist / functions undefined.

- [ ] **Step 3: Write the helpers**

```typescript
// src/lib/dialer/number-pool.ts
import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

type Admin = ReturnType<typeof createClient<Database>>;

export type PoolSettings = {
  daily_cap: number;
  warmup_days: number;
  warmup_start_cap: number;
};

export const DEFAULT_POOL_SETTINGS: PoolSettings = {
  daily_cap: 100,
  warmup_days: 14,
  warmup_start_cap: 20,
};

/** US (NANP) area code from an E.164 number (+1XXXXXXXXXX), or null. */
export function areaCodeOf(e164: string | null | undefined): string | null {
  if (!e164) return null;
  const m = /^\+1(\d{3})\d{7}$/.exec(e164.trim());
  return m ? m[1] : null;
}

/** A number's daily cap today: the mature cap, ramped up over the warm-up window
 *  so a fresh number doesn't blast high volume. Pure. */
export function effectiveDailyCap(input: {
  matureCap: number;
  warmupStartCap: number;
  warmupDays: number;
  warmupStartedAt: string | null;
  now: number;
}): number {
  const { matureCap, warmupStartCap, warmupDays, warmupStartedAt, now } = input;
  if (!warmupStartedAt || warmupDays <= 0) return matureCap;
  const ageDays = (now - new Date(warmupStartedAt).getTime()) / 86_400_000;
  if (ageDays >= warmupDays) return matureCap;
  const ramped =
    warmupStartCap + (matureCap - warmupStartCap) * (ageDays / warmupDays);
  return Math.max(warmupStartCap, Math.round(ramped));
}

export type PoolCandidate = {
  id: string;
  elevenlabsPhoneNumberId: string;
  areaCode: string | null;
  calls24h: number;
  effectiveCap: number;
  connectRate: number | null;
};

/** Choose the best number to dial from. Exact-area-code matches win; within the
 *  chosen tier, least-used-today, tie-broken by higher connect rate then a stable
 *  spread key (so equal numbers share load evenly). Returns null when every
 *  candidate is at/over its cap (pool exhausted). Pure. */
export function pickPoolNumber(
  candidates: PoolCandidate[],
  leadAreaCode: string | null,
  spreadKey: string,
): PoolCandidate | null {
  const underCap = candidates.filter((c) => c.calls24h < c.effectiveCap);
  if (underCap.length === 0) return null;
  const local = leadAreaCode
    ? underCap.filter((c) => c.areaCode === leadAreaCode)
    : [];
  const tier = local.length > 0 ? local : underCap;
  const hash = (s: string): number =>
    s.split("").reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
  return [...tier].sort(
    (a, b) =>
      a.calls24h - b.calls24h ||
      (b.connectRate ?? -1) - (a.connectRate ?? -1) ||
      hash(spreadKey + a.id) - hash(spreadKey + b.id),
  )[0];
}

/** Read the pool tunables from app_settings, falling back to defaults. */
export async function loadPoolSettings(db: Admin): Promise<PoolSettings> {
  const { data } = await db
    .from("app_settings")
    .select("number_pool_settings")
    .limit(1)
    .maybeSingle();
  const raw = (data as { number_pool_settings?: Partial<PoolSettings> } | null)
    ?.number_pool_settings;
  return { ...DEFAULT_POOL_SETTINGS, ...(raw ?? {}) };
}

/** Pick a live pool number for a campaign + lead. Loads the campaign's active,
 *  non-rested, imported numbers, their live 24h usage (via the grouped RPC), and
 *  ranks them with pickPoolNumber. Returns null when the pool is empty or fully
 *  capped (caller should defer the lead). */
export async function selectPoolNumber(
  db: Admin,
  campaignId: string,
  leadPhone: string | null,
  spreadKey: string,
): Promise<{ numberId: string; elevenlabsPhoneNumberId: string } | null> {
  const nowIso = new Date().toISOString();
  const [{ data: nums }, settings] = await Promise.all([
    db
      .from("twilio_numbers")
      .select(
        "id, elevenlabs_phone_number_id, area_code, warmup_started_at, daily_cap_override, last_connect_rate_24h",
      )
      .eq("attached_campaign_id", campaignId)
      .is("released_at", null)
      .eq("pool_status", "active")
      .eq("flagged_for_rotation", false)
      .not("elevenlabs_phone_number_id", "is", null)
      .or(`rested_until.is.null,rested_until.lte.${nowIso}`),
    loadPoolSettings(db),
  ]);
  const pool = (nums ?? []) as {
    id: string;
    elevenlabs_phone_number_id: string;
    area_code: string | null;
    warmup_started_at: string | null;
    daily_cap_override: number | null;
    last_connect_rate_24h: number | null;
  }[];
  if (pool.length === 0) return null;

  const { data: usage } = await db.rpc("pool_number_usage_24h", {
    in_campaign_id: campaignId,
  });
  const counts = new Map<string, number>();
  for (const u of (usage ?? []) as {
    twilio_number_id: string;
    calls_24h: number;
  }[]) {
    counts.set(u.twilio_number_id, Number(u.calls_24h));
  }

  const now = Date.now();
  const candidates: PoolCandidate[] = pool.map((n) => ({
    id: n.id,
    elevenlabsPhoneNumberId: n.elevenlabs_phone_number_id,
    areaCode: n.area_code,
    calls24h: counts.get(n.id) ?? 0,
    effectiveCap: effectiveDailyCap({
      matureCap: n.daily_cap_override ?? settings.daily_cap,
      warmupStartCap: settings.warmup_start_cap,
      warmupDays: settings.warmup_days,
      warmupStartedAt: n.warmup_started_at,
      now,
    }),
    connectRate: n.last_connect_rate_24h,
  }));

  const chosen = pickPoolNumber(candidates, areaCodeOf(leadPhone), spreadKey);
  return chosen
    ? {
        numberId: chosen.id,
        elevenlabsPhoneNumberId: chosen.elevenlabsPhoneNumberId,
      }
    : null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/number-pool.unit.test.ts`
Expected: PASS (12 assertions across the three describes).

- [ ] **Step 5: Commit**

```bash
git add src/lib/dialer/number-pool.ts tests/number-pool.unit.test.ts
git commit -m "feat(pool): pure number selection (area-code match, caps, warm-up) + selectPoolNumber"
```

---

## Task 3: Regenerate DB types

**Files:**

- Modify: `src/lib/supabase/database.types.ts` (generated)

- [ ] **Step 1: Regenerate**

Run: `npx supabase gen types typescript --linked > src/lib/supabase/database.types.ts`
Expected: the file now includes the new `twilio_numbers` columns
(`area_code`, `pool_status`, `rested_until`, `warmup_started_at`,
`daily_cap_override`), `app_settings.number_pool_settings`, and the
`pool_number_usage_24h` function. (If the CLI isn't wired for `--linked` types,
hand-add the columns to the `twilio_numbers` Row/Insert/Update and add the
function to `Functions` — the exact shapes are in Task 1's SQL.)

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean (the `.rpc("pool_number_usage_24h", …)` and new column reads in
`number-pool.ts` now resolve).

- [ ] **Step 3: Commit**

```bash
git add src/lib/supabase/database.types.ts
git commit -m "chore(pool): regenerate DB types for number-pool columns + RPC"
```

---

## Task 4: Dial from the pool in the tick

**Files:**

- Modify: `src/lib/dialer/tick.ts` — `placeLiveDialerCall` (currently ~lines 428-530) and its call site in `runDialerTick` (~lines 387-408).

- [ ] **Step 1: Import the selector**

At the top of `src/lib/dialer/tick.ts`, add to the imports:

```typescript
import { selectPoolNumber } from "@/lib/dialer/number-pool";
```

- [ ] **Step 2: Extend the placement result type**

Replace the `LivePlaceResult` type (near the top) with:

```typescript
/** Result of one live placement: a dialed call id, a graceful skip because the
 *  lead already has an in-flight AI outbound call, a pool-exhausted skip (no
 *  usable number right now), or a genuine error (all null/false). */
type LivePlaceResult = {
  callId: string | null;
  inFlight?: boolean;
  poolExhausted?: boolean;
};
```

- [ ] **Step 3: Select the pool number inside `placeLiveDialerCall`**

In `placeLiveDialerCall`, replace the opening guard + `calls` insert:

```typescript
if (!c.business_phone) return { callId: null };

// Pick a healthy, under-cap, area-matched number from the campaign's pool.
// Null → the whole pool is capped/rested right now: skip WITHOUT inserting a
// call; the claim lease (2 min) makes the lead retry, and volume self-throttles
// to what the pool can safely support.
const picked = await selectPoolNumber(
  supabase,
  c.campaign_id,
  c.business_phone,
  c.lead_id, // stable spread key
);
if (!picked) {
  await supabase.from("system_events").insert({
    kind: "pool_exhausted",
    actor_user_id: null,
    ref_table: "campaigns",
    ref_id: c.campaign_id,
    payload: { campaign_id: c.campaign_id, lead_id: c.lead_id },
  });
  return { callId: null, poolExhausted: true };
}

const { data: pending, error: pendingError } = await supabase
  .from("calls")
  .insert({
    lead_id: c.lead_id,
    campaign_id: c.campaign_id,
    agent_id: c.agent_id,
    twilio_number_id: picked.numberId,
    direction: "outbound",
    status: "queued",
    outcome: null,
    outcome_source: "elevenlabs",
  })
  .select("id")
  .single();
```

Then, further down in the same function, change the `resolveAndPlaceAgentCall`
call to dial from the picked number:

```typescript
const result = await resolveAndPlaceAgentCall(supabase, {
  callId: pending.id,
  agentId: c.agent_id,
  twilioNumberId: picked.numberId,
  toNumber: c.business_phone,
});
```

(The `c.twilio_number_id` field is no longer read here — it's removed from the
queue in Task 6. Leave the rest of `placeLiveDialerCall` unchanged.)

- [ ] **Step 4: Handle the pool-exhausted result at the call site**

In `runDialerTick`, in the `if (elevenLive)` branch, replace the result handling:

```typescript
if (res.callId) {
  summary.dialed++;
} else if (res.inFlight) {
  summary.blocked++;
  summary.blockedReasons["already_in_flight"] =
    (summary.blockedReasons["already_in_flight"] ?? 0) + 1;
} else if (res.poolExhausted) {
  summary.blocked++;
  summary.blockedReasons["pool_exhausted"] =
    (summary.blockedReasons["pool_exhausted"] ?? 0) + 1;
} else {
  summary.errors++;
}
```

- [ ] **Step 5: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: clean. (`placeLiveDialerCall`'s `c` no longer needs `twilio_number_id`;
if TS complains it's unused in the type, that's fine — the queue still selects it
until Task 6, and an unused field is not an error.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/dialer/tick.ts
git commit -m "feat(pool): dialer selects the pool number per call, records it, defers when exhausted"
```

---

## Task 5: `pre_call_check` — require a usable pool number

**Files:**

- Create: `supabase/migrations/20260718150100_pre_call_check_pool.sql`

- [ ] **Step 1: Write the migration (re-declare the function)**

Copy the CURRENT body from `supabase/migrations/20260619140000_pre_call_check_eastern_spend_caps.sql` verbatim, and change ONLY the Twilio-number block (the
`v_campaign.twilio_number_id is null` / `v_twilio` lookup / `twilio_number_reassigned`
checks) to a pool-existence check:

```sql
-- (replaces the old single-number validation block)
  if not exists (
    select 1 from public.twilio_numbers tn
     where tn.attached_campaign_id = in_campaign_id
       and tn.released_at is null
       and tn.pool_status = 'active'
       and tn.flagged_for_rotation = false
       and tn.elevenlabs_phone_number_id is not null
  ) then
    return 'campaign_has_no_numbers';
  end if;
```

Delete the now-unused `v_twilio public.twilio_numbers%rowtype;` declaration.
Everything else in the function (DNC, in-flight, calling hours, hourly/daily/
concurrency/spend caps) stays byte-for-byte identical. Per-number cap exhaustion
is NOT checked here — `selectPoolNumber` handles it at placement (returns null →
defer). Update the function comment to say "≥1 usable pool number".

- [ ] **Step 2: Apply**

Run: `supabase db push --linked`
Expected: `pre_call_check` re-declared; a campaign with ≥1 active pool number
passes; one with none returns `campaign_has_no_numbers`.

- [ ] **Step 3: Verify against a real campaign**

Run (SQL): `select public.pre_call_check('<a-ready-lead-id>', '<its-campaign-id>');`
Expected: `null` (still dialable) for a campaign that has its number attached —
proving the pool check is satisfied by the existing single-number setup
(backward compatible).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260718150100_pre_call_check_pool.sql
git commit -m "feat(pool): pre_call_check requires >=1 usable pool number"
```

---

## Task 6: `dial_queue` — pool-existence filter

**Files:**

- Create: `supabase/migrations/20260718150200_dial_queue_pool.sql`

- [ ] **Step 1: Write the migration (re-create the view)**

Copy the CURRENT `dial_queue` definition from
`supabase/migrations/20260611090000_dial_queue_callback_priority.sql`. Make two
changes: (a) drop `c.twilio_number_id` from the SELECT list (selection is at
placement now); (b) replace the `and c.twilio_number_id is not null` filter with a
pool-existence check.

```sql
create or replace view public.dial_queue
with (security_invoker = true)
as
select
  l.id as lead_id,
  l.owner_id,
  l.business_phone,
  l.timezone as lead_timezone,
  l.next_call_at,
  c.id as campaign_id,
  c.agent_id,
  c.calling_hours_start,
  c.calling_hours_end,
  c.calls_per_hour_cap,
  c.calls_per_day_cap,
  c.concurrency_cap_per_user,
  c.daily_spend_cap,
  c.monthly_spend_cap,
  (case when l.status = 'callback' then 0 else 1 end) as dial_priority
from public.leads l
join public.list_campaign_attachments lca
  on lca.list_id = l.list_id and lca.detached_at is null
join public.campaigns c
  on c.id = lca.campaign_id
  and c.status = 'active'
  and c.autopilot_enabled = true
where
  l.deleted_at is null
  and l.business_phone is not null
  and l.status in ('ready_to_call', 'callback')
  and (l.next_call_at is null or l.next_call_at <= now())
  and exists (
    select 1 from public.twilio_numbers tn
     where tn.attached_campaign_id = c.id
       and tn.released_at is null
       and tn.pool_status = 'active'
       and tn.flagged_for_rotation = false
       and tn.elevenlabs_phone_number_id is not null
  )
  and not exists (
    select 1 from public.dnc_entries d where d.phone = l.business_phone
  )
  and public.is_within_calling_hours(
    l.timezone, c.calling_hours_start, c.calling_hours_end
  );

comment on view public.dial_queue is
  'Leads eligible for the AUTO-dialer: ready, due, not on DNC, in calling hours, '
  'attached to an active autopilot campaign that has >=1 usable pool number. '
  'dial_priority orders callbacks (0) ahead of cold leads (1). The specific '
  'number is chosen at placement by selectPoolNumber. Re-check caps in code.';

grant select on public.dial_queue to authenticated;
```

- [ ] **Step 2: Drop the now-dead queue field in the tick's select**

In `src/lib/dialer/tick.ts` `runDialerTick`, the `dial_queue` select string lists
`twilio_number_id` — remove it:

```typescript
    .from("dial_queue")
    .select(
      "lead_id, owner_id, business_phone, campaign_id, agent_id",
    )
```

(The candidate object `c` no longer carries `twilio_number_id`; `placeLiveDialerCall`
already stopped reading it in Task 4. The mock path `placeMockCall` still reads
`c.twilio_number_id` — pass `null` there: change its call to
`{ lead_id: c.lead_id, campaign_id: c.campaign_id, agent_id: c.agent_id, twilio_number_id: null }`.)

- [ ] **Step 3: Apply + verify**

Run: `supabase db push --linked` then `select count(*) from public.dial_queue;`
Expected: applies; count is unchanged vs before for campaigns whose single number
is attached (backward compatible).

- [ ] **Step 4: Verify the app compiles**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260718150200_dial_queue_pool.sql src/lib/dialer/tick.ts
git commit -m "feat(pool): dial_queue gates on pool existence; tick drops the static number"
```

---

## Task 7: Full local verification

**Files:** none (verification only)

- [ ] **Step 1: Unit tests**

Run: `npx vitest run tests/number-pool.unit.test.ts`
Expected: PASS.

- [ ] **Step 2: Typecheck + lint + build**

Run: `npx tsc --noEmit && npx eslint src/lib/dialer/number-pool.ts src/lib/dialer/tick.ts && npm run build`
Expected: all clean.

- [ ] **Step 3: Backward-compat smoke (read-only)**

Confirm an existing single-number campaign still produces a dialer candidate and a
selected number: with `ELEVENLABS_LIVE` unset (mock), run one `runDialerTick({ limit: 1 })`
against a test lead (or inspect `selectPoolNumber(admin, campaignId, leadPhone, leadId)`
in a throwaway script) → returns the campaign's existing number. No `pool_exhausted`.

- [ ] **Step 4: Open the PR**

```bash
git push -u origin feat/number-pool-phase-1
gh pr create --title "feat(pool): number pool phase 1 — per-call selection from a campaign pool" --body "Implements Phase 1 of docs/superpowers/specs/2026-07-18-local-presence-number-pool-design.md: schema + settings + usage RPC, pure area-code/warm-up/selection helpers (unit-tested), selectPoolNumber, tick wiring (select-at-placement + defer-on-exhaustion), and pre_call_check/dial_queue pool gating. Backward compatible (single-number campaign = pool of 1). Migrations applied to prod (additive)."
```

---

## Self-review

**Spec coverage (Phase-1 slice of the spec):**

- §5 data model → Task 1 (columns, settings, backfill; `region` derived not stored — noted).
- §6 selection (Tier A + Tier C, cap, exclusions, least-used, exhaustion) → Tasks 2–3. _(Tier B same-state + the health-populated `connectRate`/`rested_until` writers are Phase 2 — selection already reads them safely as null.)_
- §7 warm-up cap → Task 2 (`effectiveDailyCap`).
- §12 wiring (`pre_call_check`, `dial_queue`, tick, `calls.twilio_number_id`) → Tasks 4–6. _(call-now/human-call use the same `selectPoolNumber` — added in Phase 3 with the UI, since they're low-volume manual paths; noted as a follow-up.)_
- §14 exhaustion/backward-compat → Tasks 4, 5, 6 (defer + `pool_exhausted` event; pool-of-1 compatibility verified).

**Deferred to later phases (by design, not gaps):** health/auto-rest cron + warm-up-repeat escalation (Phase 2), same-state Tier B + NANP map (Phase 2), bulk provisioning + area-code planner + pool UI + inbound agent-assignment-on-attach (Phase 3), capacity tuning + load test + stale-reaper hardening (Phase 4). `selectPoolNumber` already assigns nothing inbound; Phase-1 pools are populated by the existing single-number attach, so inbound is unaffected.

**Placeholder scan:** none — every code/SQL step is complete and runnable.

**Type consistency:** `PoolCandidate`, `PoolSettings`, `selectPoolNumber` return
shape (`{ numberId, elevenlabsPhoneNumberId }`), `LivePlaceResult.poolExhausted`,
and the RPC name `pool_number_usage_24h` are used identically across Tasks 1–6.

**Prod-safety note:** all three migrations are **additive** (no drops/renames);
they can deploy before the code that reads them. `selectPoolNumber` falls back to
the existing attached number, so nothing breaks between migrate and deploy.
