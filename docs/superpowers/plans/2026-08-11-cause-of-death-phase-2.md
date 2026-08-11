# Cause of Death — Phase 2 Implementation Plan (the AI objection engine)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill the "Decision-maker said no" bucket with real objection intelligence — for every conversation call that didn't reach the goal, an AI pass over the saved transcript stores an **objection category + a one-line "not interested in what" + the verbatim customer quote**, and the Cause of Death tab renders an objection breakdown + those quotes in the drill-down.

**Architecture:** Three new columns on `calls` hold the extraction. A background worker (a secret-gated cron endpoint, exactly like `/api/smart-lists/refresh`) pulls a batch of not-yet-analyzed conversation calls, runs one `gpt-5.4-mini` strict-JSON pass per transcript (mirroring `src/lib/openai/summary-merger.ts`), and writes the columns — draining the backlog of existing calls and keeping up with new ones. The prompt-building and response-parsing are pure functions (unit-tested); the OpenAI call has a mock fallback so tests never hit the network. Phase 1's `fetchCauseOfDeath` is extended to also load the objections for `dm_said_no` leads, and a pure `computeObjectionBreakdown` aggregates them for the view.

**Tech Stack:** Next.js (App Router route handler), Supabase/PostgREST, OpenAI `gpt-5.4-mini` via plain `fetch`, pg_cron + pg_net, TypeScript, Vitest. Branch: `feat/cause-of-death-phase-2` (off `main`, which now contains Phase 1). Spec: `docs/superpowers/specs/2026-08-11-cause-of-death-design.md` (§4, §5-Phase-2).

**Depends on Phase 1** (merged): `src/lib/agent-analytics/cause-of-death.ts` (`CauseKey`, `perLead`), `fetchCauseOfDeath` in `report-data.ts`, `cause-of-death-view.tsx`. The `dm_said_no` cause already exists and drills to companies; Phase 2 adds the objection layer beneath it.

---

## File structure

- **Create** `supabase/migrations/20260811140000_call_objections.sql` — 4 columns on `calls` + a partial index for the worker queue.
- **Regenerate** `src/lib/supabase/database.types.ts` — so the new columns are typed.
- **Create** `src/lib/openai/objection-extractor.ts` — the taxonomy, the pure `buildObjectionPrompt` + `parseObjectionResponse`, and `extractObjection` (the OpenAI call, with mock fallback).
- **Create** `tests/objection-extractor.unit.test.ts` — unit tests for the pure prompt/parse.
- **Create** `src/lib/reporting/objection-worker.ts` — `runObjectionExtraction(admin, opts)`: batch fetch → extract → write.
- **Create** `src/app/api/reporting/objections/route.ts` — the secret-gated cron endpoint.
- **Create** `supabase/migrations/20260811140100_objection_extraction_cron.sql` — pg_cron schedule.
- **Create** `src/lib/agent-analytics/objections.ts` — pure `computeObjectionBreakdown` + types.
- **Create** `tests/objections.unit.test.ts` — unit tests for the breakdown.
- **Modify** `src/lib/agent-analytics/report-data.ts` — `fetchCauseOfDeath` also returns per-lead objection info.
- **Modify** `src/app/(app)/reporting/cause-of-death-view.tsx` — objection breakdown under `dm_said_no` + quote/specific in the drill-down.

---

## Task 1: Migration — objection columns + worker-queue index

**Files:**

- Create: `supabase/migrations/20260811140000_call_objections.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Cause of Death Phase 2: per-call objection intelligence.
--
-- The AI objection worker (src/lib/reporting/objection-worker.ts) fills these
-- from the transcript of each CONVERSATION call that didn't reach the goal.
-- objection_analyzed_at is set even when no objection is found, so a call is
-- analyzed at most once. Nullable + additive → safe to deploy before the code.
alter table public.calls
  add column if not exists objection_category text,
  add column if not exists objection_specific text,
  add column if not exists objection_quote text,
  add column if not exists objection_analyzed_at timestamptz;

-- The worker's queue: not-yet-analyzed conversation calls that didn't win.
-- Partial index keeps it tiny and the "claim next batch" scan index-only.
create index if not exists idx_calls_objection_pending
  on public.calls (started_at)
  where objection_analyzed_at is null
    and goal_met = false
    and outcome in (
      'not_interested', 'gatekeeper', 'callback',
      'transferred_to_human', 'language_barrier'
    );

comment on column public.calls.objection_category is
  'Cause of Death Phase 2: AI-classified objection (price / already_have_solution / no_need / bad_timing / happy_with_current / confused_by_offer / distrust_spam / brush_off / other), or null when none/not-yet-analyzed.';
```

- [ ] **Step 2: Apply to prod and regenerate types**

Run:

```bash
echo "y" | env -u SUPABASE_ACCESS_TOKEN supabase db push --linked
env -u SUPABASE_ACCESS_TOKEN supabase gen types typescript --linked --schema public > src/lib/supabase/database.types.ts
npx prettier --write src/lib/supabase/database.types.ts
```

Expected: migration applies; `git diff --stat src/lib/supabase/database.types.ts` shows the four new `calls` columns added (a small diff after prettier).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260811140000_call_objections.sql src/lib/supabase/database.types.ts
git commit -m "feat(reporting): calls objection columns + worker-queue index"
```

---

## Task 2: The objection extractor — taxonomy + pure prompt/parse

**Files:**

- Create: `src/lib/openai/objection-extractor.ts`
- Test: `tests/objection-extractor.unit.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/objection-extractor.unit.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import {
  OBJECTION_CATEGORIES,
  buildObjectionPrompt,
  parseObjectionResponse,
  transcriptToText,
} from "@/lib/openai/objection-extractor";

describe("transcriptToText", () => {
  test("labels agent vs lead turns in time order", () => {
    const text = transcriptToText([
      { role: "agent", message: "Hi, is the owner in?", time_in_call_secs: 1 },
      { role: "user", message: "We already use Podium.", time_in_call_secs: 4 },
    ]);
    expect(text).toBe(
      "Agent: Hi, is the owner in?\nLead: We already use Podium.",
    );
  });

  test("handles empty / malformed transcript", () => {
    expect(transcriptToText(null)).toBe("");
    expect(transcriptToText([])).toBe("");
  });
});

describe("buildObjectionPrompt", () => {
  test("includes the transcript and the allowed categories", () => {
    const p = buildObjectionPrompt("Agent: hi\nLead: too expensive");
    expect(p).toContain("too expensive");
    for (const c of OBJECTION_CATEGORIES) expect(p).toContain(c);
  });
});

describe("parseObjectionResponse", () => {
  test("accepts a valid category + specific + quote", () => {
    const r = parseObjectionResponse(
      JSON.stringify({
        objection_present: true,
        category: "already_have_solution",
        specific: "already using Podium",
        quote: "We already use Podium for that.",
      }),
    );
    expect(r).toEqual({
      category: "already_have_solution",
      specific: "already using Podium",
      quote: "We already use Podium for that.",
    });
  });

  test("no objection → null", () => {
    expect(
      parseObjectionResponse(JSON.stringify({ objection_present: false })),
    ).toBeNull();
  });

  test("unknown category is coerced to 'other'", () => {
    const r = parseObjectionResponse(
      JSON.stringify({
        objection_present: true,
        category: "banana",
        specific: "x",
        quote: "y",
      }),
    );
    expect(r?.category).toBe("other");
  });

  test("garbage / non-JSON → null", () => {
    expect(parseObjectionResponse("not json")).toBeNull();
    expect(parseObjectionResponse("")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/objection-extractor.unit.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pure parts + the OpenAI call**

Create `src/lib/openai/objection-extractor.ts`:

```ts
import { priceOpenAiTokens } from "@/lib/costs/rates";

import { openAiKey } from "./live";

/** The model, matching summary-merger.ts (a reasoning model — no temperature /
 *  max_tokens). */
export const OBJECTION_MODEL =
  process.env.OBJECTION_MODEL?.trim() || "gpt-5.4-mini";

/** Fixed objection taxonomy. Stored verbatim in calls.objection_category. */
export const OBJECTION_CATEGORIES = [
  "price",
  "already_have_solution",
  "no_need",
  "bad_timing",
  "happy_with_current",
  "confused_by_offer",
  "distrust_spam",
  "brush_off",
  "other",
] as const;

export type ObjectionCategory = (typeof OBJECTION_CATEGORIES)[number];

export type Objection = {
  category: ObjectionCategory;
  specific: string;
  quote: string;
};

type TranscriptTurn = {
  role?: string | null;
  message?: string | null;
  time_in_call_secs?: number | null;
};

/** Render calls.transcript_json into "Agent:/Lead:" text in time order. Pure. */
export function transcriptToText(transcript: unknown): string {
  if (!Array.isArray(transcript)) return "";
  return (transcript as TranscriptTurn[])
    .filter((t) => t && typeof t.message === "string" && t.message.trim())
    .slice()
    .sort((a, b) => (a.time_in_call_secs ?? 0) - (b.time_in_call_secs ?? 0))
    .map(
      (t) => `${t.role === "agent" ? "Agent" : "Lead"}: ${t.message!.trim()}`,
    )
    .join("\n");
}

const SYSTEM_PROMPT = `You analyze a transcript of a cold sales call between OUR agent and a prospective business. The call did NOT close. Identify the LEAD's single main objection — the real reason they didn't move forward. Judge ONLY what the LEAD (the business) said; the agent's pitch is not an objection. If the lead raised no real objection (e.g. only a gatekeeper spoke, or nobody engaged), report objection_present=false.`;

const CATEGORY_GUIDE = `Choose the ONE category that best fits the lead's main objection:
- price: cost / too expensive / budget.
- already_have_solution: they already use a competitor or another tool (name it in "specific").
- no_need: it isn't relevant to their business / they don't do that.
- bad_timing: not right now / call back later / busy season.
- happy_with_current: satisfied with how they do it today, no pain.
- confused_by_offer: didn't understand what we were offering.
- distrust_spam: thinks it's a scam / spam / doesn't trust it.
- brush_off: "just email me" / non-committal deflection with no real reason.
- other: a real objection that fits none of the above.`;

/** Prompt for one call. Pure. */
export function buildObjectionPrompt(transcriptText: string): string {
  return `${CATEGORY_GUIDE}

Transcript:
${transcriptText}

Return JSON:
- "objection_present": true only if the LEAD gave a real objection; false otherwise.
- "category": one of exactly [${OBJECTION_CATEGORIES.join(", ")}].
- "specific": at most 12 words naming WHAT specifically — the competitor, the aspect, the reason (e.g. "already using Podium", "too pricey for a 2-chair salon", "no time this quarter"). Empty string if none.
- "quote": the LEAD's own words that carry the objection, copied VERBATIM from the transcript (at most ~200 chars). Empty string if none.`;
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["objection_present", "category", "specific", "quote"],
  properties: {
    objection_present: { type: "boolean" },
    category: { type: "string" },
    specific: { type: "string" },
    quote: { type: "string" },
  },
};

/** Parse the model's JSON into an Objection, or null when absent/invalid.
 *  Unknown categories coerce to "other". Pure. */
export function parseObjectionResponse(content: string): Objection | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (parsed.objection_present !== true) return null;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const raw = str(parsed.category);
  const category = (
    (OBJECTION_CATEGORIES as readonly string[]).includes(raw) ? raw : "other"
  ) as ObjectionCategory;
  return { category, specific: str(parsed.specific), quote: str(parsed.quote) };
}

/** One live gpt-5.4-mini pass. Returns the objection (or null) + token cost.
 *  Mock/no-key or any failure → { objection: null, cost: 0, mode }. Mirrors
 *  summary-merger.ts's callOpenAi. */
export async function extractObjection(transcriptText: string): Promise<{
  objection: Objection | null;
  cost: number;
  mode: "live" | "mock";
}> {
  const apiKey = openAiKey();
  if (!apiKey || !transcriptText.trim()) {
    return { objection: null, cost: 0, mode: "mock" };
  }
  let res: Response;
  try {
    res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: OBJECTION_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildObjectionPrompt(transcriptText) },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "objection", strict: true, schema: SCHEMA },
        },
      }),
    });
  } catch {
    return { objection: null, cost: 0, mode: "live" };
  }
  if (!res.ok) return { objection: null, cost: 0, mode: "live" };
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const content = data.choices?.[0]?.message?.content ?? "";
  const cost = priceOpenAiTokens(
    data.usage?.prompt_tokens ?? 0,
    data.usage?.completion_tokens ?? 0,
    OBJECTION_MODEL,
  );
  return { objection: parseObjectionResponse(content), cost, mode: "live" };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/objection-extractor.unit.test.ts` (expect PASS) and `npx tsc --noEmit` (expect 0). If `priceOpenAiTokens`'s signature differs, match the real one in `src/lib/costs/rates.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/openai/objection-extractor.ts tests/objection-extractor.unit.test.ts
git commit -m "feat(reporting): objection extractor (taxonomy + pure prompt/parse + OpenAI call)"
```

---

## Task 3: The worker — batch fetch → extract → write

**Files:**

- Create: `src/lib/reporting/objection-worker.ts`

- [ ] **Step 1: Implement**

Create `src/lib/reporting/objection-worker.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  extractObjection,
  transcriptToText,
} from "@/lib/openai/objection-extractor";
import type { Database } from "@/lib/supabase/database.types";

type Admin = SupabaseClient<Database>;

const CONVERSATION_NON_WON = [
  "not_interested",
  "gatekeeper",
  "callback",
  "transferred_to_human",
  "language_barrier",
];

/** Analyze one batch of not-yet-analyzed conversation calls: classify the
 *  lead's objection from the transcript and store it. Sets objection_analyzed_at
 *  on every call it touches (even when no objection is found) so each call is
 *  analyzed at most once — draining the backfill over successive runs. */
export async function runObjectionExtraction(
  admin: Admin,
  opts: { limit?: number } = {},
): Promise<{ analyzed: number; withObjection: number; cost: number }> {
  const limit = opts.limit ?? 25;
  const { data, error } = await admin
    .from("calls")
    .select("id, transcript_json, cost_breakdown")
    .is("objection_analyzed_at", null)
    .eq("goal_met", false)
    .in("outcome", CONVERSATION_NON_WON)
    .order("started_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);

  let withObjection = 0;
  let cost = 0;
  const nowIso = new Date().toISOString();
  for (const row of data ?? []) {
    const text = transcriptToText(
      (row as { transcript_json: unknown }).transcript_json,
    );
    const { objection, cost: c } = await extractObjection(text);
    cost += c;
    if (objection) withObjection += 1;

    const prev = ((row as { cost_breakdown: Record<string, number> | null })
      .cost_breakdown ?? {}) as Record<string, number>;
    const cost_breakdown = { ...prev, openai: (prev.openai ?? 0) + c };

    await admin
      .from("calls")
      .update({
        objection_category: objection?.category ?? null,
        objection_specific: objection?.specific || null,
        objection_quote: objection?.quote || null,
        objection_analyzed_at: nowIso,
        cost_breakdown,
      })
      .eq("id", (row as { id: string }).id);
  }
  return { analyzed: (data ?? []).length, withObjection, cost };
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit` (expect 0). If `cost_breakdown`'s type is stricter than `Record<string, number>`, adapt the cast to match `database.types.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/reporting/objection-worker.ts
git commit -m "feat(reporting): objection extraction worker (batch drain)"
```

---

## Task 4: The cron endpoint

**Files:**

- Create: `src/app/api/reporting/objections/route.ts`

- [ ] **Step 1: Implement (copy the smart-lists/refresh gate exactly)**

Create `src/app/api/reporting/objections/route.ts`:

```ts
import { NextResponse, type NextRequest } from "next/server";

import { createClient as createServiceClient } from "@supabase/supabase-js";

import { runObjectionExtraction } from "@/lib/reporting/objection-worker";
import type { Database } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";

/** Drain a batch of the objection-extraction queue. Secret-gated EXACTLY like
 *  /api/smart-lists/refresh: x-dialer-secret == DIALER_TICK_SECRET, or a
 *  signed-in admin. pg_cron hits this every few minutes via pg_net. */
export async function POST(request: NextRequest) {
  const secret = request.headers.get("x-dialer-secret");
  const expected = process.env.DIALER_TICK_SECRET ?? "";

  let authorized = false;
  if (expected && secret && secret === expected) {
    authorized = true;
  } else {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      const { data: me } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .single();
      if (me?.role === "admin") authorized = true;
    }
  }
  if (!authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    return NextResponse.json(
      { error: "Supabase service role env missing." },
      { status: 500 },
    );
  }

  try {
    const admin = createServiceClient<Database>(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const summary = await runObjectionExtraction(admin, { limit: 25 });
    return NextResponse.json(summary);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
```

- [ ] **Step 2: Typecheck + lint + commit**

Run: `npx tsc --noEmit` and `npx eslint src/app/api/reporting/objections/route.ts src/lib/reporting/objection-worker.ts src/lib/openai/objection-extractor.ts` (expect 0).

```bash
git add src/app/api/reporting/objections/route.ts
git commit -m "feat(reporting): objection extraction cron endpoint"
```

---

## Task 5: The cron schedule

**Files:**

- Create: `supabase/migrations/20260811140100_objection_extraction_cron.sql`

- [ ] **Step 1: Write the migration (mirror smart-lists-refresh)**

```sql
-- Drain the Cause-of-Death objection queue every 2 minutes.
-- Mirrors smart-lists-refresh: pg_net POST with the dialer_tick_secret as the
-- x-dialer-secret header; the endpoint rejects an empty/wrong secret (401).
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid)
from cron.job
where jobname = 'objection-extraction';

select cron.schedule(
  'objection-extraction',
  '*/2 * * * *',
  $cmd$
  select net.http_post(
    url := 'https://referrizer-smile-and-dial.vercel.app/api/reporting/objections',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-dialer-secret', coalesce(
        (select dialer_tick_secret from public.app_settings limit 1), ''
      )
    ),
    body := '{}'::jsonb
  );
  $cmd$
);
```

- [ ] **Step 2: Apply + commit** (do NOT apply until the code from Tasks 3-4 is merged/deployed, or the cron will 404 harmlessly until then — safe either way)

```bash
echo "y" | env -u SUPABASE_ACCESS_TOKEN supabase db push --linked
git add supabase/migrations/20260811140100_objection_extraction_cron.sql
git commit -m "feat(reporting): schedule objection extraction every 2 min"
```

---

## Task 6: Aggregate objections for the view (pure) + extend the fetcher

**Files:**

- Create: `src/lib/agent-analytics/objections.ts`
- Test: `tests/objections.unit.test.ts`
- Modify: `src/lib/agent-analytics/report-data.ts` (`fetchCauseOfDeath`)

- [ ] **Step 1: Write the failing test for `computeObjectionBreakdown`**

Create `tests/objections.unit.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import {
  computeObjectionBreakdown,
  type ObjectionRow,
} from "@/lib/agent-analytics/objections";

const row = (p: Partial<ObjectionRow>): ObjectionRow => ({
  leadId: "L",
  company: "Acme",
  category: null,
  specific: null,
  quote: null,
  ...p,
});

describe("computeObjectionBreakdown", () => {
  test("counts by category and keeps quote samples, most-common first", () => {
    const r = computeObjectionBreakdown([
      row({
        category: "price",
        specific: "too pricey",
        quote: "way too expensive",
      }),
      row({
        category: "price",
        specific: "budget",
        quote: "no budget this year",
      }),
      row({
        category: "already_have_solution",
        specific: "Podium",
        quote: "we use Podium",
      }),
    ]);
    expect(r.total).toBe(3);
    expect(r.byCategory[0]).toMatchObject({ category: "price", count: 2 });
    expect(r.byCategory[1]).toMatchObject({
      category: "already_have_solution",
      count: 1,
    });
    expect(r.byCategory[0].samples[0].quote).toBeTruthy();
  });

  test("rows with no category are ignored", () => {
    const r = computeObjectionBreakdown([
      row({}),
      row({ category: "no_need" }),
    ]);
    expect(r.total).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/objections.unit.test.ts` → module not found.

- [ ] **Step 3: Implement**

Create `src/lib/agent-analytics/objections.ts`:

```ts
import {
  OBJECTION_CATEGORIES,
  type ObjectionCategory,
} from "@/lib/openai/objection-extractor";

export type ObjectionRow = {
  leadId: string;
  company: string;
  category: ObjectionCategory | null;
  specific: string | null;
  quote: string | null;
};

export type ObjectionSample = {
  leadId: string;
  company: string;
  specific: string;
  quote: string;
};

export type ObjectionBreakdown = {
  total: number;
  byCategory: {
    category: ObjectionCategory;
    count: number;
    samples: ObjectionSample[];
  }[];
};

const MAX_SAMPLES = 25;

/** Aggregate per-call objections into per-category counts + quote samples,
 *  most-common category first. Rows without a category are ignored. Pure. */
export function computeObjectionBreakdown(
  rows: ObjectionRow[],
): ObjectionBreakdown {
  const buckets = new Map<
    ObjectionCategory,
    { count: number; samples: ObjectionSample[] }
  >();
  let total = 0;
  for (const r of rows) {
    if (!r.category) continue;
    total += 1;
    const b = buckets.get(r.category) ?? { count: 0, samples: [] };
    b.count += 1;
    if (b.samples.length < MAX_SAMPLES && (r.quote || r.specific)) {
      b.samples.push({
        leadId: r.leadId,
        company: r.company,
        specific: r.specific ?? "",
        quote: r.quote ?? "",
      });
    }
    buckets.set(r.category, b);
  }
  const byCategory = [...buckets.entries()]
    .map(([category, b]) => ({ category, count: b.count, samples: b.samples }))
    .sort(
      (a, b) =>
        b.count - a.count ||
        OBJECTION_CATEGORIES.indexOf(a.category) -
          OBJECTION_CATEGORIES.indexOf(b.category),
    );
  return { total, byCategory };
}
```

- [ ] **Step 4: Verify pass** — `npx vitest run tests/objections.unit.test.ts` PASS.

- [ ] **Step 5: Extend `fetchCauseOfDeath`**

In `src/lib/agent-analytics/report-data.ts`, in the calls-pagination loop of `fetchCauseOfDeath`, ALSO select `objection_category, objection_specific, objection_quote` and, while building the per-lead aggregate, keep the objection fields from that lead's calls (a lead's objection = the first non-null objection among its calls — prefer the one on a `not_interested` call). Add to the returned object an `objections: ObjectionRow[]` array (one per `dm_said_no` lead that has an objection), built by joining the per-lead cause (from `computeCauseOfDeath().perLead`) to its objection fields + `companyByLead`. Keep the change small: extend the existing `Map` value to also carry `{ category, specific, quote }` (first non-null wins), and after `computeCauseOfDeath`, emit `objections` for leads whose cause is `dm_said_no`.

- [ ] **Step 6: tsc + commit**

```bash
git add src/lib/agent-analytics/objections.ts tests/objections.unit.test.ts src/lib/agent-analytics/report-data.ts
git commit -m "feat(reporting): aggregate objections for the Cause of Death view"
```

---

## Task 7: Render the objection breakdown + quotes

**Files:**

- Modify: `src/app/(app)/reporting/cause-of-death-view.tsx`
- Modify: `src/app/(app)/reporting/page.tsx` + `src/app/share/reporting/[token]/page.tsx` (pass the new `objections` through to the view)

- [ ] **Step 1: Render**

In `cause-of-death-view.tsx`, accept `objections: ObjectionRow[]` (defaulting to `[]`), compute `computeObjectionBreakdown(objections)`, and when rendering the `dm_said_no` cause: replace the "(objection breakdown coming soon)" note with, inside the `<details>`, a small bar-per-category list (reuse the existing bar markup) and, under each category, its `samples` as `company — specific — "quote"` lines. If `objections` is empty (nothing analyzed yet), keep a muted "Objection analysis is still running…" line. The `CauseOfDeathTab` server components in both pages pass `objections={causeOfDeath.objections}` (admin) / from the share fetch.

- [ ] **Step 2: tsc + eslint + full unit suite**

Run: `npx tsc --noEmit`, `npx eslint <the changed files>`, `npx vitest run tests/cause-of-death.unit.test.ts tests/objection-extractor.unit.test.ts tests/objections.unit.test.ts` — all green.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/reporting/cause-of-death-view.tsx" "src/app/(app)/reporting/page.tsx" "src/app/share/reporting/[token]/page.tsx"
git commit -m "feat(reporting): objection breakdown + quotes in Cause of Death"
```

---

## Task 8: Kick the backfill, verify, PR

**Files:** none.

- [ ] **Step 1: Trigger a few worker runs against prod to seed data**

After the code is deployed, fire the endpoint a few times (it drains 25/run) with the prod `dialer_tick_secret` (read it from `app_settings.dialer_tick_secret` via the service key), then confirm rows populate:

```bash
# read secret, POST https://referrizer-smile-and-dial.vercel.app/api/reporting/objections a few times
# then check: count of calls with objection_analyzed_at not null, and a sample of objection_category/quote
```

The pg_cron job (Task 5) also drains it automatically every 2 min; manual firing just seeds it faster for a first look.

- [ ] **Step 2: Sanity-check cost + coverage**

Confirm the extractor mode is "live" (OpenAI key present in prod) and that `objection_category`/`objection_quote` look sensible on a handful of `not_interested` calls. Spot-check that the "Other" objection bucket isn't swallowing obvious price/competitor cases (tune `CATEGORY_GUIDE` wording if so).

- [ ] **Step 3: Push + PR**

```bash
git push -u origin feat/cause-of-death-phase-2
gh pr create --title "feat(reporting): Cause of Death Phase 2 — AI objection engine" --body "Fills the 'DM said no' bucket: a background worker runs gpt-5.4-mini over each non-won conversation transcript and stores objection_category + specific + verbatim quote on the call; the tab renders the objection breakdown + quotes. Backfills existing transcripts + runs forward via pg_cron. Pure prompt/parse + breakdown are unit-tested. Migration applied to prod."
```

---

## Self-review notes (done while writing)

- **Spec coverage:** objection category + specific + quote (Tasks 2-3), stored on calls (Task 1), backfill + forward worker + cron (Tasks 3-5), breakdown + quotes in the drill-down (Tasks 6-7), cost into cost_breakdown.openai (Task 3), customer-only via the system prompt (Task 2). Per-campaign scoping is inherited from Phase 1's `scope`/`kpiScope` (no change needed).
- **Type consistency:** `ObjectionCategory`/`Objection` (Task 2) reused by the worker (Task 3) and the breakdown (Task 6); `ObjectionRow` defined in Task 6 and consumed by Task 7; `runObjectionExtraction` return shape consumed only by the route (Task 4).
- **Cost bound:** only `goal_met=false` conversation outcomes are ever analyzed (the partial index + the worker's `.in()` filter agree), and each call is analyzed once (the `objection_analyzed_at` guard) — so the backfill is a one-time pass of a bounded set.
- **No placeholders in code steps.** Task 5-6 wiring steps describe a small, exact extension of an existing function rather than restating the whole file; the executor extends `fetchCauseOfDeath` in place.
- **Deferred (still, from Phase 1):** the CSV export button and the drill-down link to the lead/transcript — call them out to Marija if she wants them folded into this phase.
