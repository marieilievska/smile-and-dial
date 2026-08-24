# ElevenLabs Credit Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the dialer from placing calls when the shared ElevenLabs credit pool is too low to complete them — pausing each active campaign, notifying its owner and admins, and auto-resuming when credits are restored.

**Architecture:** A guard runs at the top of every dialer tick (~1/min, live mode only). It reads the live EL balance, runs a pure state-machine decision (ok / warn / low with hysteresis), and applies side effects: warn admins, pause all active campaigns (`paused_reason='low_credits'`) + notify owners on entering "low", and auto-resume the campaigns it paused (refreshing agent webhooks) on recovery. Because paused campaigns are already excluded from the queue and from `pre_call_check`, this also blocks manual "Call Now" during an outage. Fail-open on a failed balance read; never auto-resume without a confirmed reading.

**Tech Stack:** Next.js 16 (server libs), TypeScript, Supabase (service-role client), ElevenLabs REST (`/v1/user/subscription`), Vitest for unit tests.

**Reference spec:** `docs/superpowers/specs/2026-08-24-elevenlabs-credit-dialer-guard-design.md`

---

## File Structure

**New files:**

- `src/lib/elevenlabs/credit-config.ts` — env-overridable thresholds + avg-credits-per-call. Pure.
- `src/lib/elevenlabs/credit-state.ts` — `evaluateCreditState()`, the pure decision function (no I/O).
- `src/lib/elevenlabs/subscription.ts` — `getElevenLabsCreditBalance()`, the only app-code reader of the EL subscription.
- `src/lib/dialer/credit-gate.ts` — `enforceElevenLabsCreditGate()`, the orchestrator (I/O: EL read, DB, notifications).
- `supabase/migrations/20260824120000_elevenlabs_credit_guard.sql` — status table + `paused_reason` widening.
- `tests/elevenlabs-credit-state.unit.test.ts` — exhaustive pure-function tests.
- `tests/elevenlabs-credit-subscription.unit.test.ts` — fetch-mocked helper tests.
- `tests/elevenlabs-credit-gate.unit.test.ts` — orchestrator behavior (fake Supabase + mocked deps).

**Modified files:**

- `src/lib/dialer/tick.ts` — call the guard before `readFairQueue`; early-return when dialing is blocked.
- `src/lib/supabase/database.types.ts` — regenerated after the migration (new table + widened enum-ish check).

**Deliberately NOT changed:**

- `src/lib/dialer/queue.ts` `PreCallReason` union — `low_credits` is a _tick-level_ block reason, not a value `pre_call_check` returns, so it stays out of that union and lives only as a free-form `blockedReasons` key. (This corrects spec item #9.)
- `src/lib/campaigns/actions.ts` — auto-resume reuses the lower-level `applyConnectedAgentIntegration` primitive directly, so the `"use server"` file is untouched.

---

## Task 0: Feature branch + commit design docs

**Files:** none (git only)

- [ ] **Step 1: Create the feature branch**

Run:

```bash
git checkout -b feat/elevenlabs-credit-guard
```

Expected: `Switched to a new branch 'feat/elevenlabs-credit-guard'`

- [ ] **Step 2: Commit the spec and this plan**

```bash
git add docs/superpowers/specs/2026-08-24-elevenlabs-credit-dialer-guard-design.md docs/superpowers/plans/2026-08-24-elevenlabs-credit-guard.md
git commit -m "docs: spec + plan for ElevenLabs credit guard

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

Expected: one commit created on `feat/elevenlabs-credit-guard`.

---

## Task 1: Credit config module

**Files:**

- Create: `src/lib/elevenlabs/credit-config.ts`
- Test: `tests/elevenlabs-credit-config.unit.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/elevenlabs-credit-config.unit.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { creditConfig } from "@/lib/elevenlabs/credit-config";

const KEYS = [
  "EL_CREDIT_WARN_THRESHOLD",
  "EL_CREDIT_STOP_THRESHOLD",
  "EL_CREDIT_RESUME_THRESHOLD",
  "EL_CREDIT_STALE_MINUTES",
  "EL_AVG_CREDITS_PER_CALL",
];

afterEach(() => {
  for (const k of KEYS) delete process.env[k];
});

describe("creditConfig", () => {
  it("returns the balanced defaults when no env is set", () => {
    expect(creditConfig()).toEqual({
      warn: 100_000,
      stop: 35_000,
      resume: 50_000,
      staleMinutes: 15,
      avgCreditsPerCall: 530,
    });
  });

  it("honors env overrides", () => {
    process.env.EL_CREDIT_STOP_THRESHOLD = "80000";
    process.env.EL_AVG_CREDITS_PER_CALL = "600";
    const cfg = creditConfig();
    expect(cfg.stop).toBe(80_000);
    expect(cfg.avgCreditsPerCall).toBe(600);
  });

  it("ignores a negative or non-numeric override and uses the default", () => {
    process.env.EL_CREDIT_WARN_THRESHOLD = "-5";
    process.env.EL_CREDIT_RESUME_THRESHOLD = "abc";
    const cfg = creditConfig();
    expect(cfg.warn).toBe(100_000);
    expect(cfg.resume).toBe(50_000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- elevenlabs-credit-config`
Expected: FAIL — cannot find module `@/lib/elevenlabs/credit-config`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/elevenlabs/credit-config.ts`:

```ts
/**
 * Env-overridable configuration for the ElevenLabs credit guard. Numbers are
 * EL credits (EL renamed "characters" to "credits" but kept the field names).
 * Defaults are the "balanced" posture (see the design spec): stop with ~one
 * dialing round in reserve, warn well before that, resume with hysteresis.
 */
function envNum(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

export type CreditConfig = {
  /** Below this: warn admins, keep dialing. */
  warn: number;
  /** Below this: pause campaigns, stop dialing. */
  stop: number;
  /** At/above this again: auto-resume (must be >= stop for hysteresis). */
  resume: number;
  /** How long a cached balance is trusted when a live read fails. */
  staleMinutes: number;
  /** Used only to render "~N calls left" in alerts. */
  avgCreditsPerCall: number;
};

export function creditConfig(): CreditConfig {
  return {
    warn: envNum("EL_CREDIT_WARN_THRESHOLD", 100_000),
    stop: envNum("EL_CREDIT_STOP_THRESHOLD", 35_000),
    resume: envNum("EL_CREDIT_RESUME_THRESHOLD", 50_000),
    staleMinutes: envNum("EL_CREDIT_STALE_MINUTES", 15),
    avgCreditsPerCall: envNum("EL_AVG_CREDITS_PER_CALL", 530),
  };
}

/** Render a credit balance as an approximate call count for alert copy. */
export function callsLeft(
  remaining: number,
  avgCreditsPerCall: number,
): number {
  if (avgCreditsPerCall <= 0) return 0;
  return Math.max(0, Math.round(remaining / avgCreditsPerCall));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- elevenlabs-credit-config`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/elevenlabs/credit-config.ts tests/elevenlabs-credit-config.unit.test.ts
git commit -m "feat: ElevenLabs credit guard config thresholds

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Pure decision function `evaluateCreditState`

**Files:**

- Create: `src/lib/elevenlabs/credit-state.ts`
- Test: `tests/elevenlabs-credit-state.unit.test.ts`

This is the heart of the feature: all state-machine and hysteresis logic, with zero I/O.

- [ ] **Step 1: Write the failing test**

Create `tests/elevenlabs-credit-state.unit.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { evaluateCreditState } from "@/lib/elevenlabs/credit-state";

const T = { warn: 100_000, stop: 35_000, resume: 50_000 };

describe("evaluateCreditState", () => {
  it("stays OK well above the warn line", () => {
    const d = evaluateCreditState(500_000, "ok", T);
    expect(d.state).toBe("ok");
    expect(d.shouldDial).toBe(true);
    expect(d.transition).toBe("none");
  });

  it("crosses OK -> warn and flags entered_warn", () => {
    const d = evaluateCreditState(80_000, "ok", T);
    expect(d.state).toBe("warn");
    expect(d.shouldDial).toBe(true);
    expect(d.transition).toBe("entered_warn");
  });

  it("does not re-fire entered_warn while staying in warn", () => {
    const d = evaluateCreditState(70_000, "warn", T);
    expect(d.state).toBe("warn");
    expect(d.transition).toBe("none");
  });

  it("crosses warn -> low and flags entered_low", () => {
    const d = evaluateCreditState(20_000, "warn", T);
    expect(d.state).toBe("low");
    expect(d.shouldDial).toBe(false);
    expect(d.transition).toBe("entered_low");
  });

  it("stays low with still_low while below the resume line", () => {
    const d = evaluateCreditState(20_000, "low", T);
    expect(d.state).toBe("low");
    expect(d.shouldDial).toBe(false);
    expect(d.transition).toBe("still_low");
  });

  it("hysteresis: stays low between stop and resume even though > stop", () => {
    const d = evaluateCreditState(40_000, "low", T); // > stop(35k), < resume(50k)
    expect(d.state).toBe("low");
    expect(d.transition).toBe("still_low");
  });

  it("resumes once at/above the resume line", () => {
    const d = evaluateCreditState(50_000, "low", T);
    expect(d.state).toBe("warn"); // 50k is between stop and warn
    expect(d.shouldDial).toBe(true);
    expect(d.transition).toBe("resumed");
  });

  it("resume path does not emit entered_warn even though it lands in warn", () => {
    const d = evaluateCreditState(60_000, "low", T);
    expect(d.state).toBe("warn");
    expect(d.transition).toBe("resumed");
  });

  it("resumes straight to ok when it recovers past the warn line", () => {
    const d = evaluateCreditState(150_000, "low", T);
    expect(d.state).toBe("ok");
    expect(d.transition).toBe("resumed");
  });

  it("first observation (null prev) that is already low pauses immediately", () => {
    const d = evaluateCreditState(10_000, null, T);
    expect(d.state).toBe("low");
    expect(d.transition).toBe("entered_low");
  });

  it("first observation (null prev) that is healthy is OK with no transition", () => {
    const d = evaluateCreditState(500_000, null, T);
    expect(d.state).toBe("ok");
    expect(d.transition).toBe("none");
  });

  it("treats exactly the stop line as low (strictly below warn, at/below stop)", () => {
    const d = evaluateCreditState(35_000, "ok", T); // remaining == stop
    // remaining < stop is false at exactly 35k, so it's warn, not low.
    expect(d.state).toBe("warn");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- elevenlabs-credit-state`
Expected: FAIL — cannot find module `@/lib/elevenlabs/credit-state`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/elevenlabs/credit-state.ts`:

```ts
/**
 * Pure decision function for the ElevenLabs credit guard. No I/O — given the
 * current remaining credits and the previous state, it returns the new state,
 * whether the dialer may place calls, and which one-shot transition (if any)
 * fired so the orchestrator knows what side effect to run.
 *
 * Hysteresis: once "low", we stay low until credits climb back to `resume`
 * (> `stop`), so the dialer can't flap paused/active right at the stop line.
 */
export type CreditState = "ok" | "warn" | "low";

export type CreditTransition =
  | "none"
  | "entered_warn"
  | "entered_low"
  | "still_low"
  | "resumed";

export type CreditDecision = {
  state: CreditState;
  shouldDial: boolean;
  transition: CreditTransition;
};

export function evaluateCreditState(
  remaining: number,
  prevState: CreditState | null,
  t: { warn: number; stop: number; resume: number },
): CreditDecision {
  let state: CreditState;
  if (prevState === "low") {
    // Hold "low" until we've recovered to the resume line.
    if (remaining >= t.resume) {
      state = remaining >= t.warn ? "ok" : "warn";
    } else {
      state = "low";
    }
  } else if (remaining < t.stop) {
    state = "low";
  } else if (remaining < t.warn) {
    state = "warn";
  } else {
    state = "ok";
  }

  let transition: CreditTransition = "none";
  if (state === "low") {
    transition = prevState === "low" ? "still_low" : "entered_low";
  } else if (prevState === "low") {
    transition = "resumed";
  } else if (state === "warn" && prevState !== "warn") {
    // prevState is "ok" or null here (the "low" cases are handled above).
    transition = "entered_warn";
  }

  return { state, shouldDial: state !== "low", transition };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- elevenlabs-credit-state`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/elevenlabs/credit-state.ts tests/elevenlabs-credit-state.unit.test.ts
git commit -m "feat: pure credit-state decision function

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: ElevenLabs subscription reader

**Files:**

- Create: `src/lib/elevenlabs/subscription.ts`
- Test: `tests/elevenlabs-credit-subscription.unit.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/elevenlabs-credit-subscription.unit.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getElevenLabsCreditBalance } from "@/lib/elevenlabs/subscription";

const OLD_KEY = process.env.ELEVENLABS_API_KEY;

beforeEach(() => {
  process.env.ELEVENLABS_API_KEY = "test-key";
});
afterEach(() => {
  process.env.ELEVENLABS_API_KEY = OLD_KEY;
  vi.unstubAllGlobals();
});

describe("getElevenLabsCreditBalance", () => {
  it("returns remaining = limit - used from the subscription payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          character_limit: 2_000_000,
          character_count: 1_950_000,
          tier: "growing_business",
          status: "active",
          next_character_count_reset_unix: 1_800_000_000,
        }),
      }),
    );
    const bal = await getElevenLabsCreditBalance();
    expect(bal).toEqual({
      remaining: 50_000,
      limit: 2_000_000,
      used: 1_950_000,
      tier: "growing_business",
      status: "active",
      resetUnix: 1_800_000_000,
    });
  });

  it("clamps remaining to 0 when usage exceeds the limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ character_limit: 100, character_count: 250 }),
      }),
    );
    const bal = await getElevenLabsCreditBalance();
    expect(bal?.remaining).toBe(0);
  });

  it("returns null on a non-OK response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }),
    );
    expect(await getElevenLabsCreditBalance()).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    expect(await getElevenLabsCreditBalance()).toBeNull();
  });

  it("returns null when the payload has no numeric limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
    );
    expect(await getElevenLabsCreditBalance()).toBeNull();
  });

  it("returns null when no API key is configured", async () => {
    process.env.ELEVENLABS_API_KEY = "";
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    expect(await getElevenLabsCreditBalance()).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- elevenlabs-credit-subscription`
Expected: FAIL — cannot find module `@/lib/elevenlabs/subscription`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/elevenlabs/subscription.ts`:

```ts
import "server-only";

/**
 * Live ElevenLabs credit balance for the workspace. Reads the shared account's
 * subscription (there is no per-user credit budget). Returns null on any
 * failure — the caller decides how to react (the credit guard fails open).
 *
 * EL renamed "characters" to "credits" but kept the field names, so
 * character_limit / character_count are credits.
 */
export type ElevenLabsCreditBalance = {
  remaining: number;
  limit: number;
  used: number;
  tier: string | null;
  status: string | null;
  resetUnix: number | null;
};

function apiKey(): string {
  return process.env.ELEVENLABS_API_KEY?.trim() ?? "";
}

export async function getElevenLabsCreditBalance(): Promise<ElevenLabsCreditBalance | null> {
  const key = apiKey();
  if (!key) return null;
  try {
    const res = await fetch("https://api.elevenlabs.io/v1/user/subscription", {
      headers: { "xi-api-key": key },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const j: unknown = await res.json();
    const obj = (j ?? {}) as Record<string, unknown>;
    const limit = Number(obj.character_limit);
    const used = Number(obj.character_count);
    if (!Number.isFinite(limit) || !Number.isFinite(used)) return null;
    return {
      remaining: Math.max(0, limit - used),
      limit,
      used,
      tier: typeof obj.tier === "string" ? obj.tier : null,
      status: typeof obj.status === "string" ? obj.status : null,
      resetUnix: Number.isFinite(Number(obj.next_character_count_reset_unix))
        ? Number(obj.next_character_count_reset_unix)
        : null,
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- elevenlabs-credit-subscription`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/elevenlabs/subscription.ts tests/elevenlabs-credit-subscription.unit.test.ts
git commit -m "feat: getElevenLabsCreditBalance subscription reader

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Database migration (status table + paused_reason) and type regen

**Files:**

- Create: `supabase/migrations/20260824120000_elevenlabs_credit_guard.sql`
- Modify: `src/lib/supabase/database.types.ts` (regenerated)

This is additive only (new table + widened CHECK), safe to apply to prod before the code merges.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260824120000_elevenlabs_credit_guard.sql`:

```sql
-- ElevenLabs credit guard.
--
-- 1. `elevenlabs_credit_status` — single-row cache of the shared workspace
--    credit balance, written by the dialer tick's credit guard. Holds the
--    previous state (for one-shot transition detection across serverless
--    invocations) and a throttle timestamp for read-failure logging.
--    Service-role only (RLS on, no policies) — background job writes/reads it.
--
-- 2. `campaigns.paused_reason` — allow 'low_credits' so the guard can auto-pause
--    and, on recovery, auto-resume ONLY the campaigns it paused.

create table public.elevenlabs_credit_status (
  id int primary key default 1 check (id = 1),
  remaining bigint,
  credit_limit bigint,
  state text check (state in ('ok', 'warn', 'low')),
  checked_at timestamptz,
  read_error_logged_at timestamptz,
  updated_at timestamptz not null default now()
);

comment on table public.elevenlabs_credit_status is
  'Single-row cache of the shared ElevenLabs credit balance, written by the '
  'dialer tick credit guard. Service-role only.';

insert into public.elevenlabs_credit_status (id) values (1)
  on conflict (id) do nothing;

alter table public.elevenlabs_credit_status enable row level security;
-- No policies: only the service role (background jobs) reads/writes this row.

-- Widen the paused_reason CHECK to include the guard's reason.
alter table public.campaigns
  drop constraint if exists campaigns_paused_reason_check;
alter table public.campaigns
  add constraint campaigns_paused_reason_check check (
    paused_reason is null
    or paused_reason in (
      'manual', 'daily_spend_cap', 'monthly_spend_cap', 'auto', 'low_credits'
    )
  );
```

- [ ] **Step 2: Apply the migration to prod**

Run:

```bash
supabase db push --linked
```

Expected: the new migration applies cleanly; output lists `20260824120000_elevenlabs_credit_guard.sql`. (This hits the LIVE prod DB — additive, so safe.)

- [ ] **Step 3: Regenerate the Supabase types**

Run (Git Bash; the `-u` unsets the plugin's wrong-org token so the good stored login is used):

```bash
env -u SUPABASE_ACCESS_TOKEN supabase gen types typescript --linked --schema public > src/lib/supabase/database.types.ts
```

Expected: `database.types.ts` now contains an `elevenlabs_credit_status` table type. Verify:

```bash
grep -c "elevenlabs_credit_status" src/lib/supabase/database.types.ts
```

Expected: a non-zero count.

- [ ] **Step 4: Sanity-check the app still type-checks**

Run: `npx tsc --noEmit`
Expected: no new errors from the regenerated types.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260824120000_elevenlabs_credit_guard.sql src/lib/supabase/database.types.ts
git commit -m "feat: credit-status table + low_credits paused_reason (migration + types)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: The credit-guard orchestrator

**Files:**

- Create: `src/lib/dialer/credit-gate.ts`
- Test: `tests/elevenlabs-credit-gate.unit.test.ts`

The orchestrator wires the pure decision to real side effects. It imports the
reusable webhook primitive `applyConnectedAgentIntegration` directly (so the
`"use server"` campaigns file is untouched).

- [ ] **Step 1: Write the failing test**

Create `tests/elevenlabs-credit-gate.unit.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the two external effects so the orchestrator can be tested in isolation.
const getBalance = vi.fn();
vi.mock("@/lib/elevenlabs/subscription", () => ({
  getElevenLabsCreditBalance: () => getBalance(),
}));
vi.mock("@/lib/elevenlabs/agents", () => ({
  applyConnectedAgentIntegration: vi.fn().mockResolvedValue(undefined),
}));

import { enforceElevenLabsCreditGate } from "@/lib/dialer/credit-gate";

/**
 * Minimal chainable fake of the Supabase service client covering only the
 * calls the guard makes. `tables` supplies canned select results per table;
 * inserts/updates are recorded for assertions.
 */
function makeFakeSupabase(opts: {
  prevState?: string | null;
  activeCampaigns?: Array<{ id: string; owner_id: string; name: string }>;
  lowCreditPaused?: Array<{
    id: string;
    owner_id: string;
    name: string;
    agent_id: string | null;
  }>;
  admins?: Array<{ id: string }>;
}) {
  const notifications: Array<Record<string, unknown>> = [];
  const systemEvents: Array<Record<string, unknown>> = [];
  const campaignUpdates: Array<Record<string, unknown>> = [];
  const statusUpserts: Array<Record<string, unknown>> = [];

  function from(table: string) {
    if (table === "elevenlabs_credit_status") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data:
                opts.prevState === undefined
                  ? null
                  : { state: opts.prevState, read_error_logged_at: null },
            }),
          }),
        }),
        upsert: async (row: Record<string, unknown>) => {
          statusUpserts.push(row);
          return { error: null };
        },
      };
    }
    if (table === "campaigns") {
      return {
        // update(...).eq('status','active').select(...) -> pause path
        update: (patch: Record<string, unknown>) => ({
          eq: (col: string, val: string) => ({
            select: async () => {
              campaignUpdates.push({ patch, col, val });
              if (patch.status === "paused") {
                return { data: opts.activeCampaigns ?? [], error: null };
              }
              return { data: [], error: null };
            },
            // resume path: update(...).eq('id', id) with no .select()
            then: undefined,
          }),
        }),
        // select('...').eq('status','paused').eq('paused_reason','low_credits')
        select: () => ({
          eq: () => ({
            eq: async () => ({ data: opts.lowCreditPaused ?? [], error: null }),
          }),
        }),
      };
    }
    if (table === "agents") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { elevenlabs_agent_id: "el_agent_1", tools_enabled: {} },
            }),
          }),
        }),
      };
    }
    if (table === "profiles") {
      return {
        select: () => ({
          eq: async () => ({ data: opts.admins ?? [], error: null }),
        }),
      };
    }
    if (table === "notifications") {
      return {
        insert: async (
          rows: Record<string, unknown> | Record<string, unknown>[],
        ) => {
          for (const r of Array.isArray(rows) ? rows : [rows])
            notifications.push(r);
          return { error: null };
        },
      };
    }
    if (table === "system_events") {
      return {
        insert: async (row: Record<string, unknown>) => {
          systemEvents.push(row);
          return { error: null };
        },
      };
    }
    throw new Error(`unexpected table ${table}`);
  }

  return {
    client: { from } as never,
    notifications,
    systemEvents,
    campaignUpdates,
    statusUpserts,
  };
}

beforeEach(() => {
  getBalance.mockReset();
});

describe("enforceElevenLabsCreditGate", () => {
  it("fails open (keeps dialing, no pause) when the balance read returns null", async () => {
    getBalance.mockResolvedValue(null);
    const fake = makeFakeSupabase({ prevState: "ok" });
    const res = await enforceElevenLabsCreditGate(fake.client);
    expect(res.dialingBlocked).toBe(false);
    expect(fake.campaignUpdates).toHaveLength(0);
  });

  it("stays blocked (no resume) when read fails and prior state was low", async () => {
    getBalance.mockResolvedValue(null);
    const fake = makeFakeSupabase({ prevState: "low" });
    const res = await enforceElevenLabsCreditGate(fake.client);
    expect(res.dialingBlocked).toBe(true);
    expect(fake.campaignUpdates).toHaveLength(0); // no resume attempted
  });

  it("on entering low: pauses active campaigns and notifies owners + admins", async () => {
    getBalance.mockResolvedValue({
      remaining: 10_000,
      limit: 2_000_000,
      used: 1_990_000,
      tier: "growing_business",
      status: "active",
      resetUnix: null,
    });
    const fake = makeFakeSupabase({
      prevState: "ok",
      activeCampaigns: [
        { id: "c1", owner_id: "u1", name: "Alpha" },
        { id: "c2", owner_id: "u2", name: "Beta" },
      ],
      admins: [{ id: "admin1" }],
    });
    const res = await enforceElevenLabsCreditGate(fake.client);

    expect(res.dialingBlocked).toBe(true);
    // Campaigns were paused with the low_credits reason.
    expect(fake.campaignUpdates[0].patch).toMatchObject({
      status: "paused",
      paused_reason: "low_credits",
    });
    // Each owner + the admin got a notification.
    const recipients = fake.notifications.map((n) => n.user_id).sort();
    expect(recipients).toEqual(["admin1", "u1", "u2"]);
    // An audit event was written.
    expect(
      fake.systemEvents.some((e) => e.kind === "elevenlabs_credits_low"),
    ).toBe(true);
  });

  it("on recovery: resumes low_credits campaigns and notifies", async () => {
    getBalance.mockResolvedValue({
      remaining: 60_000,
      limit: 2_000_000,
      used: 1_940_000,
      tier: "growing_business",
      status: "active",
      resetUnix: null,
    });
    const fake = makeFakeSupabase({
      prevState: "low",
      lowCreditPaused: [
        { id: "c1", owner_id: "u1", name: "Alpha", agent_id: "a1" },
      ],
      admins: [{ id: "admin1" }],
    });
    const res = await enforceElevenLabsCreditGate(fake.client);

    expect(res.dialingBlocked).toBe(false);
    // The paused campaign was flipped back to active.
    expect(
      fake.campaignUpdates.some(
        (u) => (u.patch as Record<string, unknown>).status === "active",
      ),
    ).toBe(true);
    // Owner + admin notified of the resume.
    const recipients = fake.notifications.map((n) => n.user_id).sort();
    expect(recipients).toEqual(["admin1", "u1"]);
  });

  it("warns admins (only) on ok -> warn without pausing", async () => {
    getBalance.mockResolvedValue({
      remaining: 80_000,
      limit: 2_000_000,
      used: 1_920_000,
      tier: "growing_business",
      status: "active",
      resetUnix: null,
    });
    const fake = makeFakeSupabase({
      prevState: "ok",
      admins: [{ id: "admin1" }],
    });
    const res = await enforceElevenLabsCreditGate(fake.client);

    expect(res.dialingBlocked).toBe(false);
    expect(fake.campaignUpdates).toHaveLength(0);
    expect(fake.notifications.map((n) => n.user_id)).toEqual(["admin1"]);
    expect(fake.notifications[0].kind).toBe("elevenlabs_credits_low");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- elevenlabs-credit-gate`
Expected: FAIL — cannot find module `@/lib/dialer/credit-gate`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/dialer/credit-gate.ts`:

```ts
import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import { applyConnectedAgentIntegration } from "@/lib/elevenlabs/agents";
import type { ToolsEnabled } from "@/lib/agents/prompt";
import { callsLeft, creditConfig } from "@/lib/elevenlabs/credit-config";
import {
  type CreditState,
  evaluateCreditState,
} from "@/lib/elevenlabs/credit-state";
import { getElevenLabsCreditBalance } from "@/lib/elevenlabs/subscription";

type Supabase = SupabaseClient<Database>;

export type CreditGateResult = {
  dialingBlocked: boolean;
  state: CreditState | "unknown";
  paused: number;
  resumed: number;
};

/** Read-failure log throttle so a sustained EL outage can't flood system_events. */
const READ_ERROR_LOG_THROTTLE_MS = 30 * 60 * 1000;

/**
 * Credit guard for the dialer tick. Reads the shared ElevenLabs balance and:
 *  - warns admins as credits get low (still dialing),
 *  - pauses every active campaign + notifies each owner when they run out,
 *  - auto-resumes the campaigns it paused (refreshing agent webhooks) on
 *    recovery.
 * Fails open on a failed balance read (never pauses); never auto-resumes
 * without a confirmed reading (a read failure leaves paused campaigns paused).
 *
 * Call this only in live mode (ELEVENLABS_LIVE === "live"); mock calls consume
 * no credits.
 */
export async function enforceElevenLabsCreditGate(
  supabase: Supabase,
): Promise<CreditGateResult> {
  const cfg = creditConfig();

  const { data: prev } = await supabase
    .from("elevenlabs_credit_status")
    .select("state, read_error_logged_at")
    .eq("id", 1)
    .maybeSingle();
  const prevState = (prev?.state ?? null) as CreditState | null;

  const balance = await getElevenLabsCreditBalance();

  // Fail-open on read failure: keep dialing unless we were already low (then
  // stay blocked — don't resume on an unconfirmed reading).
  if (!balance) {
    await logReadFailure(supabase, prev?.read_error_logged_at ?? null);
    return {
      dialingBlocked: prevState === "low",
      state: prevState ?? "unknown",
      paused: 0,
      resumed: 0,
    };
  }

  const decision = evaluateCreditState(balance.remaining, prevState, cfg);
  const nowIso = new Date().toISOString();

  await supabase.from("elevenlabs_credit_status").upsert({
    id: 1,
    remaining: balance.remaining,
    credit_limit: balance.limit,
    state: decision.state,
    checked_at: nowIso,
    updated_at: nowIso,
  });

  const left = callsLeft(balance.remaining, cfg.avgCreditsPerCall);
  let paused = 0;
  let resumed = 0;

  if (decision.transition === "entered_warn") {
    await notifyAdmins(
      supabase,
      "elevenlabs_credits_low",
      `ElevenLabs credits are getting low (~${left} calls left). Top up soon to avoid the dialer pausing.`,
    );
    await logEvent(supabase, "elevenlabs_credits_warn", {
      remaining: balance.remaining,
      calls_left: left,
    });
  } else if (
    decision.transition === "entered_low" ||
    decision.transition === "still_low"
  ) {
    paused = await pauseActiveCampaigns(supabase, nowIso, left);
    if (decision.transition === "entered_low") {
      await notifyAdmins(
        supabase,
        "dialer_paused_low_credits",
        `The dialer paused: ElevenLabs credits are too low (~${left} calls left). It will resume automatically once credits are restored.`,
      );
      await logEvent(supabase, "elevenlabs_credits_low", {
        remaining: balance.remaining,
        calls_left: left,
        campaigns_paused: paused,
      });
    }
  } else if (decision.transition === "resumed") {
    resumed = await resumeLowCreditCampaigns(supabase);
    await notifyAdmins(
      supabase,
      "dialer_resumed_credits_restored",
      `ElevenLabs credits restored (~${left} calls' worth). The dialer resumed automatically.`,
    );
    await logEvent(supabase, "elevenlabs_credits_restored", {
      remaining: balance.remaining,
      calls_left: left,
      campaigns_resumed: resumed,
    });
  }

  return {
    dialingBlocked: !decision.shouldDial,
    state: decision.state,
    paused,
    resumed,
  };
}

/** Pause every currently-active campaign; notify each owner. Returns count. */
async function pauseActiveCampaigns(
  supabase: Supabase,
  nowIso: string,
  left: number,
): Promise<number> {
  const { data: flipped } = await supabase
    .from("campaigns")
    .update({
      status: "paused",
      paused_at: nowIso,
      paused_reason: "low_credits",
    })
    .eq("status", "active")
    .select("id, owner_id, name");
  const rows = flipped ?? [];
  if (rows.length > 0) {
    await supabase.from("notifications").insert(
      rows.map((c) => ({
        user_id: c.owner_id,
        kind: "campaign_paused_low_credits",
        message: `Your campaign "${c.name}" was paused — the account is low on ElevenLabs credits (~${left} calls left). It will resume automatically once credits are restored.`,
        ref_table: "campaigns",
        ref_id: c.id,
      })),
    );
  }
  return rows.length;
}

/** Resume campaigns WE paused for low credits; refresh webhooks; notify owners. */
async function resumeLowCreditCampaigns(supabase: Supabase): Promise<number> {
  const { data: toResume } = await supabase
    .from("campaigns")
    .select("id, owner_id, name, agent_id")
    .eq("status", "paused")
    .eq("paused_reason", "low_credits");
  const rows = toResume ?? [];
  for (const c of rows) {
    await supabase
      .from("campaigns")
      .update({ status: "active", paused_at: null, paused_reason: null })
      .eq("id", c.id);
    await reapplyAgentWebhook(supabase, c.agent_id);
    await supabase.from("notifications").insert({
      user_id: c.owner_id,
      kind: "campaign_resumed_credits_restored",
      message: `Your campaign "${c.name}" resumed — ElevenLabs credits are restored.`,
      ref_table: "campaigns",
      ref_id: c.id,
    });
  }
  return rows.length;
}

/** Refresh an agent's ElevenLabs webhooks (mirrors resumeCampaign). Best-effort. */
async function reapplyAgentWebhook(
  supabase: Supabase,
  campaignAgentId: string | null | undefined,
): Promise<void> {
  if (!campaignAgentId) return;
  const { data: agent } = await supabase
    .from("agents")
    .select("elevenlabs_agent_id, tools_enabled")
    .eq("id", campaignAgentId)
    .maybeSingle();
  if (!agent?.elevenlabs_agent_id) return;
  try {
    await applyConnectedAgentIntegration(
      agent.elevenlabs_agent_id,
      (agent.tools_enabled ?? undefined) as unknown as ToolsEnabled | undefined,
    );
  } catch {
    // best-effort — a webhook sync hiccup must not break the tick
  }
}

async function notifyAdmins(
  supabase: Supabase,
  kind: string,
  message: string,
): Promise<void> {
  const { data: admins } = await supabase
    .from("profiles")
    .select("id")
    .eq("role", "admin");
  if (!admins?.length) return;
  await supabase
    .from("notifications")
    .insert(admins.map((a) => ({ user_id: a.id, kind, message })));
}

async function logEvent(
  supabase: Supabase,
  kind: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await supabase.from("system_events").insert({
    kind,
    actor_user_id: null,
    ref_table: "elevenlabs_credit_status",
    ref_id: null,
    payload,
  });
}

async function logReadFailure(
  supabase: Supabase,
  lastLoggedAt: string | null,
): Promise<void> {
  const now = Date.now();
  if (
    lastLoggedAt &&
    now - new Date(lastLoggedAt).getTime() < READ_ERROR_LOG_THROTTLE_MS
  ) {
    return; // throttled
  }
  const nowIso = new Date(now).toISOString();
  await supabase
    .from("elevenlabs_credit_status")
    .upsert({ id: 1, read_error_logged_at: nowIso, updated_at: nowIso });
  await logEvent(supabase, "elevenlabs_credit_check_failed", {});
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- elevenlabs-credit-gate`
Expected: PASS (5 tests). If the fake's chaining shape needs a tweak to match the implementation's exact call order, adjust the fake (not the assertions) until green.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors. (Confirms the `Database` types include `elevenlabs_credit_status` from Task 4 and the campaign/agents/notifications columns line up.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/dialer/credit-gate.ts tests/elevenlabs-credit-gate.unit.test.ts
git commit -m "feat: dialer credit-guard orchestrator (pause/resume/notify)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Wire the guard into the dialer tick

**Files:**

- Modify: `src/lib/dialer/tick.ts` (import near line 19; call inside `runDialerTick` before `readFairQueue` ~line 496)

- [ ] **Step 1: Add the import**

In `src/lib/dialer/tick.ts`, add to the import block (after the other `@/lib/dialer/*` imports, e.g. after line 17):

```ts
import { enforceElevenLabsCreditGate } from "@/lib/dialer/credit-gate";
```

- [ ] **Step 2: Insert the guard call**

In `runDialerTick`, immediately after the stuck-callback sweep block (the `try { callbacksSwept = ... }` ending ~line 486) and BEFORE the `const fair = await readFairQueue(...)` call (~line 496), insert:

```ts
// Credit guard: before we read the queue, check the shared ElevenLabs credit
// pool. When it's too low we pause active campaigns (blocking this tick's
// dials AND manual Call-Now via pre_call_check) and stop here; when credits
// recover the guard resumes those campaigns so readFairQueue picks them up
// again below. Live mode only — mock calls consume no credits.
if (elevenLive) {
  const credit = await enforceElevenLabsCreditGate(supabase);
  if (credit.dialingBlocked) {
    return {
      candidates: 0,
      dialed: 0,
      blocked: 0,
      errors: 0,
      blockedReasons: { low_credits: 1 },
      skippedCampaignBlocked: 0,
      campaignsRead: 0,
      candidatesByCampaign: {},
      callbacksSwept,
      liveMode: { twilio: twilioLive, elevenlabs: elevenLive },
    };
  }
}
```

- [ ] **Step 3: Type-check and lint**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm run lint`
Expected: no new errors in `tick.ts` or the new files.

- [ ] **Step 4: Run the full unit suite**

Run: `npm run test:unit`
Expected: all credit-guard tests pass; no other suite regressed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/dialer/tick.ts
git commit -m "feat: run the ElevenLabs credit guard at the top of the dialer tick

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Full verification, build, and ship

**Files:** none (verification + git)

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: build succeeds (no type or bundling errors). `server-only` in the new modules must not leak into a client bundle — a failure here means something imported them from a client component.

- [ ] **Step 2: Full verification gate**

Run each and confirm clean:

```bash
npx tsc --noEmit
npm run lint
npm run test:unit
```

Expected: all pass. (CI Playwright was removed — this local gate is the contract.)

- [ ] **Step 3: Push the branch and open a PR**

```bash
git push -u origin feat/elevenlabs-credit-guard
gh pr create --title "ElevenLabs credit guard for the dialer" --body "$(cat <<'EOF'
## What

Stops the dialer from placing calls when the shared ElevenLabs credit pool is too low to complete them, so we stop wasting calls during a credit outage (the 2026-08-11 scenario: 880 dead calls over 5h, no signal).

Every dialer tick (live mode), a guard reads the live EL balance and runs a pure state machine:
- **Warn (~190 calls left):** notify admins, keep dialing.
- **Low (~65 calls left):** pause every active campaign (`paused_reason='low_credits'`), notify each owner + admins. Also blocks manual Call-Now via `pre_call_check`.
- **Resume (~95 calls left):** auto-resume only the campaigns we paused (refreshing agent webhooks) + notify.

Fail-open on a failed balance read; never auto-resumes without a confirmed reading. All thresholds are env-overridable.

## Changes
- New: `credit-config.ts`, `credit-state.ts` (pure), `subscription.ts`, `credit-gate.ts`.
- Migration: `elevenlabs_credit_status` table + `low_credits` paused_reason (applied to prod).
- Wired into `runDialerTick`.
- Unit tests for the decision matrix, the subscription reader, and the orchestrator.

Spec: `docs/superpowers/specs/2026-08-24-elevenlabs-credit-dialer-guard-design.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR created. (Migration was already applied in Task 4; Vercel auto-deploys on merge.)

- [ ] **Step 4: Post-merge verification**

After merge + deploy, confirm the guard is running: on the next live tick, the `elevenlabs_credit_status` row should have a fresh `checked_at` and a `state` (query via the service role). Cross-check the number against the daily-outcome-audit `credit-check.js` script.

---

## Self-Review (completed)

**Spec coverage:**

- Stop dialing before dry → Task 6 (tick early-return) + Task 5 (pause). ✅
- Pause each active campaign + notify owner → Task 5 `pauseActiveCampaigns`. ✅
- Warn admins only → Task 5 `entered_warn` → `notifyAdmins`. ✅
- Auto-resume only what we paused + refresh webhooks → Task 5 `resumeLowCreditCampaigns` + `reapplyAgentWebhook`. ✅
- Balanced thresholds, env-overridable → Task 1. ✅
- Fail-open on read error / fail-safe on resume → Task 5 null-balance branch. ✅
- Read-failure log throttle (no system_events flood) → Task 5 `logReadFailure`. ✅
- Single-row status table (not app_settings) → Task 4. ✅
- Covers manual Call-Now via paused campaigns → noted in Task 6 comment (pre_call_check `campaign_not_active`). ✅
- No live external test-writes → all tests mock EL + DB. ✅

**Placeholder scan:** none — every step has full code/SQL/commands.

**Type consistency:** `evaluateCreditState(remaining, prevState, {warn,stop,resume})` signature matches across Tasks 2/5; `CreditState` union shared; `enforceElevenLabsCreditGate(supabase) -> CreditGateResult` matches Task 6 call site; notification columns (`user_id, kind, message, ref_table, ref_id`) match the schema; `applyConnectedAgentIntegration(agentId, toolsEnabled?)` matches its real call site in `campaigns/actions.ts`.

**Known execution note:** the fake Supabase in the Task 5 test models the exact chain shapes the orchestrator uses. If, while implementing, the real call order differs (e.g. an extra `.eq`), adjust the fake to match the implementation — keep the assertions.
