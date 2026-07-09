# Call Reviewer — Discovery Pass (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An hourly **discovery pass** that samples recent human-reached calls the fixed rubric flagged with _nothing_ (its blind spots), asks the Pass-2 model "what recurring situation here do the existing flags miss?", and writes each proposal as a **candidate flag** (`is_candidate=true, active=false`) — which an admin then **approves** (joins the live rubric) or **dismisses** from a "Suggested new flags" panel on the Call Review tab.

**Architecture:** A secret-gated endpoint (`/api/review/discover`, mirroring `/api/review/tick`) runs one discovery pass per call. The pass samples recent `done`+`reached_human` calls that have **no confirmed flags**, feeds their summaries + the current rubric (active keys, pending candidate keys, and previously-dismissed labels so nothing is re-proposed) to the Pass-2 model via the existing `callOpenAiJson` structured-output helper, and inserts genuinely-new proposals into `review_flag_defs` as candidates. The Call Review tab gains a candidates panel; approve/dismiss are admin-gated service-role actions in the existing `src/lib/review/actions.ts`. pg_cron calls the endpoint hourly.

**Tech Stack:** Next.js App Router route handler + server actions; Supabase (service-role worker writes, RLS admin reads); the existing `src/lib/review/openai.ts` (`callOpenAiJson`, `PASS2_MODEL`) and worker `admin()` pattern; Vitest for pure-function unit tests; Tailwind.

**Deploy note:** Vercel is now live — deploys flow on push to `main`. Migrations are additive; apply with `supabase db push --linked` BEFORE the code deploy (Task 1). The discovery pass stays dormant until (a) `OPENAI_API_KEY` + real `REVIEW_PASS2_MODEL` are set and (b) an hourly pg_cron POSTs `/api/review/discover` with `DIALER_TICK_SECRET` — same operational gate as the engine tick.

**Baseline gate expectations:** `npx tsc --noEmit` has 3 pre-existing `twilio-*.spec.ts` errors — expected; no NEW errors. `npx eslint` + `npm run build` clean. Unit tests: `npm run test:unit`.

---

## File Structure

**Create:**

- `supabase/migrations/20260708150000_review_candidates.sql` — candidate metadata columns on `review_flag_defs`.
- `src/lib/review/discovery.ts` — pure helpers (`buildDiscoveryPrompt`, `dedupeProposals`, `DISCOVERY_SCHEMA`, types) + I/O (`sampleUnflaggedCalls`, `runDiscoveryPass`).
- `src/app/api/review/discover/route.ts` — secret-gated POST → `runDiscoveryPass`.
- `src/app/(app)/reporting/suggested-flags-panel.tsx` — client component: the candidates list with Approve/Dismiss.

**Modify:**

- `src/lib/supabase/database.types.ts` — add the new `review_flag_defs` columns to `Row`/`Insert`/`Update`.
- `src/lib/review/actions.ts` — add `approveCandidate`, `dismissCandidate` (admin-gated, service-role).
- `src/lib/review/buckets.ts` — add `fetchCandidateFlags(client)` returning pending candidates.
- `src/app/(app)/reporting/page.tsx` — fetch candidates in `CallReviewTab`, render the panel above the buckets.
- `src/app/(app)/reporting/call-review-table.tsx` — accept + render the `SuggestedFlagsPanel` (or the page renders it as a sibling; see Task 5).
- `tests/call-reviewer.unit.test.ts` — unit tests for `buildDiscoveryPrompt` + `dedupeProposals`.

---

## Task 1: Candidate metadata migration

**Files:**

- Create: `supabase/migrations/20260708150000_review_candidates.sql`
- Modify: `src/lib/supabase/database.types.ts`

- [ ] **Step 1: Write the migration**

The seeded rubric already has `is_candidate` / `active`. Discovery needs to store WHY a candidate was proposed, the example calls, when, and whether it was dismissed (so the pass never re-proposes a rejected idea). All additive + nullable.

Create `supabase/migrations/20260708150000_review_candidates.sql`:

```sql
-- Phase 3 (Discovery): candidate metadata on the rubric. A candidate is a row
-- with is_candidate=true, active=false, dismissed_at IS NULL. Approve →
-- is_candidate=false, active=true. Dismiss → dismissed_at=now() (kept, not
-- deleted, so the hourly pass can be told "don't re-propose this").
alter table public.review_flag_defs
  add column if not exists rationale text,
  add column if not exists example_call_ids uuid[] not null default '{}',
  add column if not exists proposed_at timestamptz,
  add column if not exists dismissed_at timestamptz;

-- Fast lookup of the three candidate cohorts the discovery prompt + UI need.
create index if not exists review_flag_defs_candidate_idx
  on public.review_flag_defs (is_candidate, dismissed_at);
```

- [ ] **Step 2: Apply to prod**

Run: `supabase db push --linked`
Expected: applies `20260708150000_review_candidates.sql` with no error (additive columns only).

- [ ] **Step 3: Hand-edit `database.types.ts`**

Find `review_flag_defs` under `public.Tables` in `src/lib/supabase/database.types.ts`. Add the four columns to its `Row`, `Insert`, and `Update` blocks, matching the existing style. In `Row`: `rationale: string | null`, `example_call_ids: string[]`, `proposed_at: string | null`, `dismissed_at: string | null`. In `Insert` and `Update`: the same keys, all optional (`rationale?: string | null`, `example_call_ids?: string[]`, `proposed_at?: string | null`, `dismissed_at?: string | null`). (Postgres `uuid[]` surfaces as `string[]` in the JS client.)

- [ ] **Step 4: Verify types**

Run: `npx tsc --noEmit`
Expected: only the 3 pre-existing twilio errors.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260708150000_review_candidates.sql src/lib/supabase/database.types.ts
git commit -m "feat(review): candidate metadata columns for discovery pass"
```

---

## Task 2: Discovery data layer + unit tests

**Files:**

- Create: `src/lib/review/discovery.ts`
- Test: `tests/call-reviewer.unit.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `tests/call-reviewer.unit.test.ts` (this file already imports from `"vitest"` — reuse its `describe/it/expect`; add the import for the new symbols):

```ts
import {
  buildDiscoveryPrompt,
  dedupeProposals,
  type DiscoverySample,
  type ProposedCandidate,
} from "@/lib/review/discovery";

describe("buildDiscoveryPrompt", () => {
  const samples: DiscoverySample[] = [
    {
      callId: "c1",
      summary: "Caller asked if we integrate with Mindbody. Agent didn't know.",
    },
    {
      callId: "c2",
      summary: "Caller wanted Spanish; agent only spoke English.",
    },
  ];
  it("lists existing + candidate keys as off-limits and includes the samples", () => {
    const p = buildDiscoveryPrompt({
      samples,
      activeKeys: ["tool_error", "price_objection"],
      candidateKeys: ["mentions_franchise"],
      dismissedLabels: ["Weather smalltalk"],
    });
    expect(p).toContain("tool_error");
    expect(p).toContain("price_objection");
    expect(p).toContain("mentions_franchise");
    expect(p).toContain("Weather smalltalk");
    expect(p).toContain("c1");
    expect(p).toContain("Mindbody");
  });
  it("still builds with empty existing/candidate/dismissed lists", () => {
    const p = buildDiscoveryPrompt({
      samples,
      activeKeys: [],
      candidateKeys: [],
      dismissedLabels: [],
    });
    expect(p).toContain("c2");
  });
});

describe("dedupeProposals", () => {
  const existing = new Set([
    "tool_error",
    "price_objection",
    "mentions_franchise",
  ]);
  const dismissed = new Set(["weather_smalltalk"]);
  const base: ProposedCandidate = {
    key: "x",
    label: "X",
    lens: "voc",
    severity: 4,
    guidance: "g",
    rationale: "r",
    exampleCallIds: ["c1"],
  };
  it("drops proposals whose key already exists (active or candidate) or was dismissed", () => {
    const out = dedupeProposals(
      [
        { ...base, key: "tool_error" },
        { ...base, key: "weather_smalltalk" },
        { ...base, key: "software_integration_gap" },
      ],
      existing,
      dismissed,
    );
    expect(out.map((p) => p.key)).toEqual(["software_integration_gap"]);
  });
  it("drops proposals with an invalid lens or out-of-range severity", () => {
    const out = dedupeProposals(
      [
        { ...base, key: "a", lens: "nonsense" as ProposedCandidate["lens"] },
        { ...base, key: "b", severity: 9 },
        { ...base, key: "c" },
      ],
      existing,
      dismissed,
    );
    expect(out.map((p) => p.key)).toEqual(["c"]);
  });
  it("de-dupes repeated keys within one batch", () => {
    const out = dedupeProposals(
      [
        { ...base, key: "dup" },
        { ...base, key: "dup" },
      ],
      existing,
      dismissed,
    );
    expect(out).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:unit`
Expected: FAIL — `@/lib/review/discovery` not found.

- [ ] **Step 3: Implement `src/lib/review/discovery.ts`**

```ts
import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { callOpenAiJson, PASS2_MODEL } from "./openai";

type Admin = ReturnType<typeof createClient<Database>>;

const LENSES = ["bug", "compliance", "quality", "opportunity", "voc"] as const;
type Lens = (typeof LENSES)[number];

/** One sampled call fed to the discovery model (summary only — cheap, and
 *  enough to spot recurring themes; full transcripts would blow the budget). */
export type DiscoverySample = { callId: string; summary: string };

/** A raw proposal from the model, before validation/dedup. */
export type ProposedCandidate = {
  key: string;
  label: string;
  lens: Lens;
  severity: number;
  guidance: string;
  rationale: string;
  exampleCallIds: string[];
};

export type DiscoveryPassSummary = {
  sampled: number;
  proposed: number;
  inserted: number;
  live: boolean;
  cost: number;
};

/** JSON schema forcing structured proposals. Kept small; the model may return
 *  an empty array when the rubric already covers everything. */
export const DISCOVERY_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["candidates"],
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "key",
          "label",
          "lens",
          "severity",
          "guidance",
          "rationale",
          "example_call_ids",
        ],
        properties: {
          key: { type: "string" },
          label: { type: "string" },
          lens: { type: "string", enum: [...LENSES] },
          severity: { type: "integer" },
          guidance: { type: "string" },
          rationale: { type: "string" },
          example_call_ids: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

/** Build the discovery user-prompt. Pure. Tells the model which keys/labels are
 *  already covered or previously rejected so it only proposes genuinely-new,
 *  recurring patterns. */
export function buildDiscoveryPrompt(input: {
  samples: DiscoverySample[];
  activeKeys: string[];
  candidateKeys: string[];
  dismissedLabels: string[];
}): string {
  const off = [...input.activeKeys, ...input.candidateKeys];
  const lines: string[] = [];
  lines.push(
    "You are reviewing recent sales/booking phone calls that our fixed flag rubric did NOT flag.",
    "Propose NEW recurring situations worth flagging that the existing flags miss.",
    "Only propose a pattern you can see recurring across MULTIPLE calls below. Return an empty list if nothing recurs.",
    "",
    `Existing flag keys (do NOT re-propose these): ${off.length ? off.join(", ") : "(none)"}`,
    `Previously rejected ideas (do NOT re-propose): ${input.dismissedLabels.length ? input.dismissedLabels.join("; ") : "(none)"}`,
    "",
    "For each new flag give: a snake_case key, a short label, a lens (bug|compliance|quality|opportunity|voc), a severity 1 (high) to 4 (info), one-sentence analyzer guidance, a one-sentence rationale, and the example_call_ids it appears in.",
    "",
    "Calls (id: summary):",
  );
  for (const s of input.samples) lines.push(`- ${s.callId}: ${s.summary}`);
  return lines.join("\n");
}

/** Validate + de-dupe raw proposals. Pure. Drops anything whose key already
 *  exists (active or pending candidate) or was dismissed, has a bad lens/
 *  severity, or repeats within the batch. */
export function dedupeProposals(
  proposals: ProposedCandidate[],
  existingKeys: Set<string>,
  dismissedKeys: Set<string>,
): ProposedCandidate[] {
  const seen = new Set<string>();
  const out: ProposedCandidate[] = [];
  for (const p of proposals) {
    const key = (p.key || "").trim();
    if (!key) continue;
    if (existingKeys.has(key) || dismissedKeys.has(key) || seen.has(key))
      continue;
    if (!LENSES.includes(p.lens)) continue;
    if (!Number.isInteger(p.severity) || p.severity < 1 || p.severity > 4)
      continue;
    seen.add(key);
    out.push({ ...p, key });
  }
  return out;
}

/** Sample recent human-reached calls that carry NO confirmed flags (the
 *  rubric's blind spots), returning their summaries. Two cheap bounded queries
 *  (recent confirmed-flag call ids, recent done+reached_human reviews) diffed in
 *  JS — avoids a NOT-IN subquery PostgREST can't express cleanly. */
export async function sampleUnflaggedCalls(
  admin: Admin,
  limit = 40,
): Promise<DiscoverySample[]> {
  const { data: flagged } = await admin
    .from("call_review_flags")
    .select("call_id")
    .eq("status", "confirmed")
    .order("id", { ascending: false })
    .limit(4000);
  const flaggedSet = new Set((flagged ?? []).map((f) => f.call_id));

  const { data: reviews } = await admin
    .from("call_reviews")
    .select("call_id")
    .eq("status", "done")
    .eq("reached_human", true)
    .order("analyzed_at", { ascending: false })
    .limit(600);

  const candidateIds = (reviews ?? [])
    .map((r) => r.call_id)
    .filter((id) => !flaggedSet.has(id))
    .slice(0, limit);
  if (candidateIds.length === 0) return [];

  const { data: calls } = await admin
    .from("calls")
    .select("id, summary")
    .in("id", candidateIds);
  return (calls ?? [])
    .map((c) => ({ callId: c.id, summary: (c.summary ?? "").trim() }))
    .filter((s) => s.summary.length > 0);
}

/** Run one discovery pass: sample → propose (Pass-2 model) → validate/dedup →
 *  insert candidates. Idempotent-ish: duplicate keys are dropped by dedup and by
 *  the unique(key) constraint (ignoreDuplicates on insert). */
export async function runDiscoveryPass(
  admin: Admin,
  opts: { sampleLimit?: number } = {},
): Promise<DiscoveryPassSummary> {
  const samples = await sampleUnflaggedCalls(admin, opts.sampleLimit ?? 40);
  if (samples.length === 0)
    return { sampled: 0, proposed: 0, inserted: 0, live: false, cost: 0 };

  const { data: defs } = await admin
    .from("review_flag_defs")
    .select("key, label, active, is_candidate, dismissed_at");
  const activeKeys = (defs ?? []).filter((d) => d.active).map((d) => d.key);
  const candidateKeys = (defs ?? [])
    .filter((d) => d.is_candidate && !d.dismissed_at)
    .map((d) => d.key);
  const dismissed = (defs ?? []).filter((d) => d.dismissed_at);
  const existingKeys = new Set((defs ?? []).map((d) => d.key));
  const dismissedKeys = new Set(dismissed.map((d) => d.key));

  const prompt = buildDiscoveryPrompt({
    samples,
    activeKeys,
    candidateKeys,
    dismissedLabels: dismissed.map((d) => d.label),
  });

  const { data, cost, live } = await callOpenAiJson<{ candidates: unknown[] }>({
    model: PASS2_MODEL,
    system:
      "You find recurring, flaggable situations in call summaries that an existing rubric misses. Be conservative: propose only clear, recurring patterns. Output must match the schema.",
    user: prompt,
    schema: DISCOVERY_SCHEMA,
    schemaName: "discovery",
    mock: { candidates: [] },
  });

  const raw = (data?.candidates ?? []) as Record<string, unknown>[];
  const proposals: ProposedCandidate[] = raw.map((c) => ({
    key: String(c.key ?? ""),
    label: String(c.label ?? ""),
    lens: c.lens as Lens,
    severity: Number(c.severity ?? 0),
    guidance: String(c.guidance ?? ""),
    rationale: String(c.rationale ?? ""),
    exampleCallIds: Array.isArray(c.example_call_ids)
      ? (c.example_call_ids as unknown[]).map(String)
      : [],
  }));
  const fresh = dedupeProposals(proposals, existingKeys, dismissedKeys);

  let inserted = 0;
  if (fresh.length > 0) {
    // Only keep example ids that were actually in this sample (guards against
    // the model inventing uuids that would violate nothing but mislead the UI).
    const sampleIds = new Set(samples.map((s) => s.callId));
    const rows = fresh.map((p) => ({
      key: p.key,
      label: p.label,
      lens: p.lens,
      severity: p.severity,
      guidance: p.guidance,
      rationale: p.rationale,
      example_call_ids: p.exampleCallIds.filter((id) => sampleIds.has(id)),
      active: false,
      is_candidate: true,
      proposed_at: new Date().toISOString(),
    }));
    const { data: ins } = await admin
      .from("review_flag_defs")
      .upsert(rows, { onConflict: "key", ignoreDuplicates: true })
      .select("key");
    inserted = ins?.length ?? 0;
  }

  return {
    sampled: samples.length,
    proposed: proposals.length,
    inserted,
    live,
    cost,
  };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm run test:unit`
Expected: PASS (new `buildDiscoveryPrompt` + `dedupeProposals` suites green; existing suites still pass).

- [ ] **Step 5: Verify types + lint**

Run: `npx tsc --noEmit && npx eslint src/lib/review/discovery.ts tests/call-reviewer.unit.test.ts`
Expected: only 3 known tsc errors; eslint clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/review/discovery.ts tests/call-reviewer.unit.test.ts
git commit -m "feat(review): discovery pass data layer + unit tests"
```

---

## Task 3: Discovery endpoint

**Files:**

- Create: `src/app/api/review/discover/route.ts`

- [ ] **Step 1: Implement the route (mirrors `/api/review/tick`)**

Read `src/app/api/review/tick/route.ts` first and copy its auth shape exactly (accepts `x-dialer-secret` matching `DIALER_TICK_SECRET`, else falls back to an admin session).

```ts
import { NextResponse, type NextRequest } from "next/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { runDiscoveryPass } from "@/lib/review/discovery";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  const secret = request.headers.get("x-dialer-secret");
  const expected = process.env.DIALER_TICK_SECRET ?? "";
  let authorized = Boolean(expected && secret && secret === expected);
  if (!authorized) {
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
  if (!authorized)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const admin = createAdminClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    return NextResponse.json(await runDiscoveryPass(admin));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
```

- [ ] **Step 2: Verify types + lint + build**

Run: `npx tsc --noEmit && npx eslint src/app/api/review/discover/route.ts && npm run build`
Expected: only 3 known tsc errors; eslint clean; build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/review/discover/route.ts
git commit -m "feat(review): secret-gated /api/review/discover endpoint"
```

---

## Task 4: Approve / dismiss actions + candidate fetch

**Files:**

- Modify: `src/lib/review/actions.ts`
- Modify: `src/lib/review/buckets.ts`

- [ ] **Step 1: Add the candidate fetch to `buckets.ts`**

Append to `src/lib/review/buckets.ts`:

```ts
/** A pending candidate flag for the "Suggested new flags" panel. */
export type CandidateFlag = {
  key: string;
  label: string;
  lens: ReviewFlagDef["lens"];
  severity: number;
  guidance: string;
  rationale: string | null;
  exampleCallIds: string[];
  proposedAt: string | null;
};

/** Pending (not-yet-approved, not-dismissed) discovery candidates, newest
 *  first. Read through the caller's admin-gated RLS client. */
export async function fetchCandidateFlags(
  client: ServerClient,
): Promise<CandidateFlag[]> {
  const { data } = await client
    .from("review_flag_defs")
    .select(
      "key, label, lens, severity, guidance, rationale, example_call_ids, proposed_at",
    )
    .eq("is_candidate", true)
    .is("dismissed_at", null)
    .order("proposed_at", { ascending: false });
  return (data ?? []).map((d) => ({
    key: d.key,
    label: d.label,
    lens: d.lens as ReviewFlagDef["lens"],
    severity: d.severity,
    guidance: d.guidance,
    rationale: d.rationale,
    exampleCallIds: d.example_call_ids ?? [],
    proposedAt: d.proposed_at,
  }));
}
```

- [ ] **Step 2: Add approve/dismiss to `actions.ts`**

Append to `src/lib/review/actions.ts` (reuse its existing `currentAdminId()` + `adminClient()`):

```ts
/** Approve a discovery candidate: it joins the live rubric (active=true,
 *  is_candidate=false) and Pass 1 will check it on future calls. Admin-only. */
export async function approveCandidate(input: {
  key: string;
}): Promise<{ error: string | null }> {
  if (!(await currentAdminId())) return { error: "Admins only." };
  const { error } = await adminClient()
    .from("review_flag_defs")
    .update({ active: true, is_candidate: false, dismissed_at: null })
    .eq("key", input.key)
    .eq("is_candidate", true);
  if (error) return { error: "Could not approve the suggestion." };
  revalidatePath("/reporting");
  return { error: null };
}

/** Dismiss a candidate: kept (not deleted) with dismissed_at set so the hourly
 *  pass is told not to re-propose it. Admin-only. */
export async function dismissCandidate(input: {
  key: string;
}): Promise<{ error: string | null }> {
  if (!(await currentAdminId())) return { error: "Admins only." };
  const { error } = await adminClient()
    .from("review_flag_defs")
    .update({ dismissed_at: new Date().toISOString() })
    .eq("key", input.key)
    .eq("is_candidate", true);
  if (error) return { error: "Could not dismiss the suggestion." };
  revalidatePath("/reporting");
  return { error: null };
}
```

- [ ] **Step 3: Verify types + lint**

Run: `npx tsc --noEmit && npx eslint src/lib/review/actions.ts src/lib/review/buckets.ts`
Expected: only 3 known tsc errors; eslint clean.

- [ ] **Step 4: Commit**

```bash
git add src/lib/review/actions.ts src/lib/review/buckets.ts
git commit -m "feat(review): approve/dismiss candidate actions + candidate fetch"
```

---

## Task 5: "Suggested new flags" panel

**Files:**

- Create: `src/app/(app)/reporting/suggested-flags-panel.tsx`
- Modify: `src/app/(app)/reporting/page.tsx`

- [ ] **Step 1: Build the panel**

Create `src/app/(app)/reporting/suggested-flags-panel.tsx`:

```tsx
"use client";

import { useTransition } from "react";
import { Lightbulb } from "lucide-react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { approveCandidate, dismissCandidate } from "@/lib/review/actions";
import type { CandidateFlag } from "@/lib/review/buckets";

export function SuggestedFlagsPanel({
  candidates,
}: {
  candidates: CandidateFlag[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  if (candidates.length === 0) return null;

  function act(key: string, fn: typeof approveCandidate, okMsg: string) {
    start(async () => {
      const res = await fn({ key });
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success(okMsg);
      router.refresh();
    });
  }

  return (
    <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-4">
      <div className="mb-3 flex items-center gap-2">
        <Lightbulb className="size-5 text-indigo-600" />
        <h3 className="text-foreground text-sm font-semibold">
          Suggested new flags
        </h3>
        <Badge variant="secondary">{candidates.length}</Badge>
      </div>
      <p className="text-muted-foreground mb-3 text-xs">
        The reviewer spotted these recurring situations the current flags don’t
        cover. Approve one to add it to the rubric, or dismiss it.
      </p>
      <div className="flex flex-col gap-2">
        {candidates.map((c) => (
          <div
            key={c.key}
            className="border-border/70 bg-card flex items-start justify-between gap-3 rounded-lg border p-3"
          >
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="text-foreground text-sm font-medium">
                  {c.label}
                </span>
                <Badge variant="outline">{c.lens}</Badge>
                <Badge variant="outline">sev {c.severity}</Badge>
              </div>
              {c.rationale ? (
                <p className="text-muted-foreground text-xs">{c.rationale}</p>
              ) : null}
              <p className="text-muted-foreground text-xs italic">
                Checks: {c.guidance}
              </p>
              {c.exampleCallIds.length > 0 ? (
                <p className="text-muted-foreground text-xs">
                  {c.exampleCallIds.length} example call
                  {c.exampleCallIds.length === 1 ? "" : "s"}
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 gap-1">
              <Button
                size="sm"
                disabled={pending}
                onClick={() =>
                  act(c.key, approveCandidate, "Added to the rubric")
                }
              >
                Approve
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => act(c.key, dismissCandidate, "Dismissed")}
              >
                Dismiss
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire it into `CallReviewTab` in `page.tsx`**

In `src/app/(app)/reporting/page.tsx`, add imports:

```ts
import { fetchReviewBuckets, fetchCandidateFlags } from "@/lib/review/buckets";
import { SuggestedFlagsPanel } from "./suggested-flags-panel";
```

(The `fetchReviewBuckets` import already exists — merge `fetchCandidateFlags` into it rather than duplicating.)

Update the `CallReviewTab` component to fetch candidates and render the panel above the bucket table:

```tsx
async function CallReviewTab() {
  const supabase = await createClient();
  const [{ summary, buckets }, candidates] = await Promise.all([
    fetchReviewBuckets(supabase),
    fetchCandidateFlags(supabase),
  ]);
  return (
    <div className="flex flex-col gap-5">
      <SuggestedFlagsPanel candidates={candidates} />
      <CallReviewTable summary={summary} buckets={buckets} />
    </div>
  );
}
```

- [ ] **Step 3: Verify types + lint + build**

Run: `npx tsc --noEmit && npx eslint "src/app/(app)/reporting/suggested-flags-panel.tsx" "src/app/(app)/reporting/page.tsx" && npm run build`
Expected: only 3 known tsc errors; eslint clean; build succeeds.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/reporting/suggested-flags-panel.tsx" "src/app/(app)/reporting/page.tsx"
git commit -m "feat(review): Suggested new flags panel (approve/dismiss candidates)"
```

---

## Task 6: Full-branch review + merge + deploy

**Files:** none (review + verification only)

- [ ] **Step 1: Full gate suite**

Run: `npx tsc --noEmit && npx eslint . && npm run build && npm run test:unit`
Expected: only the 3 known tsc errors; eslint clean; build succeeds; vitest green.

- [ ] **Step 2: Dispatch `superpowers:code-reviewer`** against the branch diff vs `main`, with this plan + the spec's "Discovery pass" section as the contract. Focus: candidate keys can't collide with or silently overwrite real rubric flags (approve/dismiss both filter `is_candidate=true`); the discovery pass never re-proposes dismissed/existing ideas; the sample→propose→insert path is safe when there are zero samples or the model is in mock mode; no member can approve/dismiss (server-side admin re-check). Fix Critical/Important; note Minor.

- [ ] **Step 3: Manual checklist**

- [ ] `approveCandidate`/`dismissCandidate` both scope updates with `.eq("is_candidate", true)` so they can never flip a real seeded flag.
- [ ] Discovery prompt passes active keys + pending candidate keys + dismissed labels → no re-proposals.
- [ ] `runDiscoveryPass` returns cleanly (no insert) when `sampleUnflaggedCalls` is empty or `callOpenAiJson` is in mock mode (`live=false`, `candidates: []`).
- [ ] `example_call_ids` are filtered to the actual sample set before insert.
- [ ] Panel renders nothing when there are no candidates (no empty box on the tab).

- [ ] **Step 4: Merge, push, deploy**

```bash
git checkout main
git merge --no-ff feat/call-reviewer-discovery -m "Merge feat/call-reviewer-discovery: Call Reviewer Phase 3 (discovery pass)"
git push origin main
```

Vercel auto-deploys on push. The migration (Task 1) is already applied to prod, so the deploy is in-sync. Verify the deploy reaches `Ready` (`vercel ls --prod`).

- [ ] **Step 5: Operational note (report to user, do not action)**

To make discovery live: add an hourly pg_cron job POSTing `https://<prod>/api/review/discover` with header `x-dialer-secret: <DIALER_TICK_SECRET>` (same secret as the engine tick). It needs `OPENAI_API_KEY` + a real `REVIEW_PASS2_MODEL`; until then it runs in mock mode and proposes nothing.

---

## Self-Review

**Spec coverage (Discovery pass §92–94, §101, §124):**

- Hourly pass sampling recent human-reached calls weighted to low/no-flag → Task 2 (`sampleUnflaggedCalls` = no-confirmed-flag calls) + Task 3 (endpoint) + Task 6 (pg_cron note). ✅
- Ask the model what recurring situation the existing flags miss → Task 2 (`buildDiscoveryPrompt`, passes active/candidate/dismissed). ✅
- Proposals → `review_flag_defs` (`is_candidate=true, active=false`) with key/label/lens/severity + example call ids + rationale → Task 1 (columns) + Task 2 (insert). ✅
- Admin approves (→active) / dismisses in a "Suggested new flags" panel → Task 4 (actions) + Task 5 (UI). ✅
- Cheap / sampled, not exhaustive → summaries only, one Pass-2 call, ~40 calls/run. ✅
- Don't re-propose dismissed ideas → `dismissed_at` kept + passed to the prompt + filtered in `dedupeProposals`. ✅

**Placeholder scan:** none — every step has complete code. ✅

**Type consistency:** `ProposedCandidate`/`DiscoverySample`/`DISCOVERY_SCHEMA` defined in `discovery.ts`, used in its own tests. `CandidateFlag` produced by `fetchCandidateFlags` (buckets.ts), consumed by `SuggestedFlagsPanel`. `approveCandidate`/`dismissCandidate` signatures (`{ key }`) match between actions.ts and the panel. `example_call_ids` is `string[]` end to end. `lens` union matches the seeded `review_flag_defs` check constraint. ✅
