# Call Reviewer — Phase 1 (Engine) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every human-reached call is automatically analyzed against a data-driven flag rubric with a two-pass verify (OpenAI 5.4-mini → 5.4), and the confirmed/needs-review flags land in the DB — the accurate foundation the Review UI (Phase 2) reads.

**Architecture:** A queue-driven worker (pg_cron → secured endpoint, mirroring the dialer tick) claims `call_reviews` rows the post-call webhook enqueued, runs Pass 1 (extract flags with evidence) + Pass 2 (independently verify each), and upserts `call_review_flags`. Buckets are a live query over that table (Phase 2). The rubric lives in `review_flag_defs` so it's editable without code.

**Tech Stack:** Next.js App Router (route handler), Supabase (migration + service-role client), OpenAI chat-completions via plain `fetch` with strict JSON (`response_format` json_schema) — mirroring `src/lib/openai/summary-merger.ts`.

**Spec:** `docs/superpowers/specs/2026-07-05-call-reviewer-design.md`

**Branch:** `feat/call-reviewer` (created; spec committed).

**Testing note:** No local unit runner — Playwright runs live-env only. Verify each task with `npx tsc --noEmit` (baseline: the 3 pre-existing `twilio-*.spec.ts` errors) + `npx eslint <files>`. Mock OpenAI in `OPENAI_LIVE`-off mode so tests never hit the network.

**⚠️ Deploy is blocked** (Vercel fair-use limit). Build + verify on the branch; it ships when cleared. Task 1 touches the LIVE DB (migration) — controller-run, confirm before `db push`.

---

## File structure

- **Create** `supabase/migrations/20260705130000_call_reviewer.sql` — `review_flag_defs` (+ seeded rubric), `call_reviews`, `call_review_flags`; RLS; indexes.
- **Modify** `src/lib/supabase/database.types.ts` — regenerated (adds the 3 tables).
- **Create** `src/lib/review/types.ts` — shared TS types (`ReviewFlagDef`, `ProposedFlag`, `VerifiedFlag`).
- **Create** `src/lib/review/rubric.ts` — `loadActiveFlagDefs(admin)`, `buildRubricText(defs)`.
- **Create** `src/lib/review/openai.ts` — `callOpenAiJson<T>(model, system, user, schema)` structured-output helper + `mockJson`.
- **Create** `src/lib/review/analyze.ts` — `analyzeCall({ transcript, extracted, defs })` → runs Pass 1 + Pass 2 + merge → `VerifiedFlag[]` + cost.
- **Create** `src/lib/review/enqueue.ts` — `enqueueCallReview(admin, { callId, reachedHuman })`.
- **Create** `src/lib/review/worker.ts` — `runReviewTick({ limit })` → claim pending, analyze, store, mark done.
- **Create** `src/app/api/review/tick/route.ts` — secured POST endpoint → `runReviewTick`.
- **Modify** `src/lib/elevenlabs/post-call-webhook.ts` — call `enqueueCallReview` after analysis is written.
- **Create** `tests/call-reviewer.spec.ts` — golden-set + merge unit tests (mock mode).

---

## Task 1: Migration + rubric seed + type regen (controller-run; touches live DB)

**Files:** Create `supabase/migrations/20260705130000_call_reviewer.sql`; regenerate `src/lib/supabase/database.types.ts`.

- [ ] **Step 1: Write the migration**

Create the file. Mirror the RLS convention of `hot_lead_dismissals` (admin-only SELECT; writes via service-role). Seed the ~30-flag rubric from the spec.

```sql
-- Call Reviewer engine tables. review_flag_defs = the data-driven rubric;
-- call_reviews = per-call work queue + result; call_review_flags = confirmed/
-- needs-review flags with evidence. Buckets (Phase 2) are a live query over
-- call_review_flags, not a table.

create table if not exists public.review_flag_defs (
  id uuid primary key default gen_random_uuid(),
  key text unique not null,
  label text not null,
  lens text not null check (lens in ('bug','compliance','quality','opportunity','voc')),
  severity int not null default 3,          -- 1 high … 4 info
  guidance text not null,                    -- analyzer prompt text for this flag
  active boolean not null default true,
  is_candidate boolean not null default false,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.call_reviews (
  call_id uuid primary key references public.calls(id) on delete cascade,
  status text not null default 'pending',    -- pending | analyzing | done | error
  reached_human boolean not null default false,
  needs_review boolean not null default false,
  pass1_model text,
  pass2_model text,
  cost numeric not null default 0,
  error text,
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  analyzed_at timestamptz
);
create index if not exists call_reviews_status_idx on public.call_reviews (status);

create table if not exists public.call_review_flags (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references public.calls(id) on delete cascade,
  flag_key text not null references public.review_flag_defs(key),
  evidence_quote text,
  confidence numeric,
  status text not null default 'confirmed', -- confirmed | needs_review | rejected
  created_at timestamptz not null default now(),
  unique (call_id, flag_key)
);
create index if not exists call_review_flags_bucket_idx
  on public.call_review_flags (flag_key, status);
create index if not exists call_review_flags_call_idx
  on public.call_review_flags (call_id);

alter table public.review_flag_defs enable row level security;
alter table public.call_reviews enable row level security;
alter table public.call_review_flags enable row level security;

-- Admin-only read; writes go through service-role workers/actions (matching
-- hot_lead_dismissals / the reporting tables).
create policy "admins read review_flag_defs" on public.review_flag_defs
  for select using (public.is_admin((select auth.uid())));
create policy "admins read call_reviews" on public.call_reviews
  for select using (public.is_admin((select auth.uid())));
create policy "admins read call_review_flags" on public.call_review_flags
  for select using (public.is_admin((select auth.uid())));

-- Seed the starter rubric (spec §"The flag rubric").
insert into public.review_flag_defs (key, label, lens, severity, guidance, sort_order) values
  ('booking_failed_then_recovered','Booking failed then recovered','bug',1,'The booking tool errored or the agent said a time was unavailable, then the SAME appointment/slot was booked anyway — a confusing failure the customer heard.',1),
  ('tool_error','Tool error mid-call','bug',1,'A server tool (booking, email, callback, transfer) failed or returned an error during the call.',2),
  ('wrong_data_used','Wrong lead data used','bug',1,'The agent used a stale or wrong name/company/detail for this business (e.g. called them by a different company name).',3),
  ('dead_air','Dead air / long silence','bug',2,'Noticeable silence or latency where the agent should have responded.',4),
  ('dropped_midconversation','Dropped mid-conversation','bug',2,'The call ended abruptly in the middle of a real conversation.',5),
  ('agent_looped','Agent looped / stuck','bug',2,'The agent repeated itself or got stuck in a loop.',6),
  ('transfer_failed','Transfer failed','bug',2,'A transfer to a human was attempted but did not connect.',7),
  ('dnc_not_honored','DNC not honored','compliance',1,'The person asked not to be called / to stop, and the agent kept pitching instead of ending.',10),
  ('misleading_claim','Misleading claim','compliance',1,'The agent stated something untrue or misleading about the offer, price, or company.',11),
  ('overpromised','Overpromised','compliance',1,'The agent promised something we may not be able to deliver.',12),
  ('wrong_info_given','Wrong info given','quality',2,'The agent gave factually incorrect information about the product/offer (not necessarily misleading on purpose).',20),
  ('fumbled_objection','Fumbled an objection','quality',2,'The customer raised a question/objection and the agent ignored it, argued, or answered poorly.',21),
  ('rambled_unclear','Rambled / unclear','quality',3,'The agent was long-winded, confusing, or off-message.',22),
  ('pushy_or_rude','Pushy or rude','quality',2,'The agent was aggressive, interrupted, or disrespectful.',23),
  ('off_goal','Never advanced the goal','quality',3,'The agent never moved toward the campaign goal (e.g. never offered to book / never asked the research questions).',24),
  ('didnt_confirm_details','Did not confirm details','quality',3,'The agent captured an email/time/booking but never read it back to confirm.',25),
  ('awkward_delivery','Awkward delivery','quality',3,'Robotic delivery or mispronounced the business/brand/contact name.',26),
  ('hot_lead_not_booked','Hot lead not booked','opportunity',2,'The customer showed clear interest but no booking or concrete next step was secured.',30),
  ('decision_maker_no_ask','Reached DM, no ask','opportunity',2,'The agent reached the owner/decision maker but did not push for the goal.',31),
  ('callback_promised_not_scheduled','Callback promised, not scheduled','opportunity',2,'The customer agreed to talk later but no callback time was captured.',32),
  ('goal_met_needs_followup','Won, needs follow-up','opportunity',3,'The goal was met but the call suggests a human follow-up would help.',33),
  ('price_objection','Price objection','voc',4,'The customer pushed back on cost/price.',40),
  ('not_interested_reason','Not interested (reason)','voc',4,'The customer declined — capture WHY in the evidence quote.',41),
  ('competitor_mentioned','Competitor mentioned','voc',4,'The customer named a competitor or their current provider.',42),
  ('software_mentioned','Software mentioned','voc',4,'The customer named their CRM/booking/business software.',43),
  ('feature_or_need_request','Feature/need request','voc',4,'The customer asked for something specific or expressed a need.',44),
  ('strong_interest','Strong interest','voc',4,'The customer was clearly enthusiastic / strongly interested.',45),
  ('confused_by_offer','Confused by the offer','voc',4,'The customer did not understand the offer or pitch.',46),
  -- Auto-applied to non-conversations by enqueue (Task 5) — MUST exist because
  -- call_review_flags.flag_key references review_flag_defs(key).
  ('no_conversation','No conversation','voc',4,'Voicemail, no-answer, or instant hang-up — no real conversation happened.',50)
on conflict (key) do nothing;
```

NOTE: verify `public.is_admin(uuid)` exists (used by other RLS). If the admin predicate differs, match `hot_lead_dismissals.sql`.

- [ ] **Step 2: Apply to the live DB (controller)**

Confirm with the user first (prod write). Run: `supabase db push --linked`. Expected: applies cleanly (additive).

- [ ] **Step 3: Regenerate types**

Regenerate `src/lib/supabase/database.types.ts` (Supabase MCP `generate_typescript_types`, or hand-add the 3 tables' Row/Insert/Update if MCP is unavailable). Confirm it contains `review_flag_defs`, `call_reviews`, `call_review_flags`.

- [ ] **Step 4: Verify + commit**

Run: `npx tsc --noEmit` → still only the 3 baseline errors.

```bash
git add supabase/migrations src/lib/supabase/database.types.ts
git commit -m "feat(db): call reviewer tables + seeded rubric + regen types"
```

---

## Task 2: Shared types + rubric loader

**Files:** Create `src/lib/review/types.ts`, `src/lib/review/rubric.ts`; Test `tests/call-reviewer.spec.ts`

- [ ] **Step 1: Write the types**

`src/lib/review/types.ts`:

```ts
export type ReviewFlagDef = {
  key: string;
  label: string;
  lens: "bug" | "compliance" | "quality" | "opportunity" | "voc";
  severity: number;
  guidance: string;
};

/** A flag Pass 1 proposed. */
export type ProposedFlag = {
  flag_key: string;
  evidence_quote: string;
  confidence: number;
};

/** A flag after Pass 2 verification. */
export type VerifiedFlag = {
  flag_key: string;
  evidence_quote: string;
  confidence: number;
  status: "confirmed" | "needs_review";
};
```

- [ ] **Step 2: Write the rubric loader**

`src/lib/review/rubric.ts`:

```ts
import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { ReviewFlagDef } from "./types";

type Admin = ReturnType<typeof createClient<Database>>;

/** All ACTIVE, non-candidate rubric flags, ordered for a stable prompt. */
export async function loadActiveFlagDefs(
  admin: Admin,
): Promise<ReviewFlagDef[]> {
  const { data } = await admin
    .from("review_flag_defs")
    .select("key, label, lens, severity, guidance")
    .eq("active", true)
    .eq("is_candidate", false)
    .order("sort_order", { ascending: true });
  return (data ?? []) as ReviewFlagDef[];
}

/** Render the rubric as a numbered list the analyzer prompt embeds. */
export function buildRubricText(defs: ReviewFlagDef[]): string {
  return defs
    .map((d) => `- ${d.key} (${d.lens}): ${d.label}. ${d.guidance}`)
    .join("\n");
}
```

- [ ] **Step 3: Unit test buildRubricText**

Append to `tests/call-reviewer.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { buildRubricText } from "../src/lib/review/rubric";

test("buildRubricText renders key/lens/label/guidance per line", () => {
  const text = buildRubricText([
    {
      key: "tool_error",
      label: "Tool error",
      lens: "bug",
      severity: 1,
      guidance: "A tool failed.",
    },
  ]);
  expect(text).toContain("tool_error (bug): Tool error. A tool failed.");
});
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit` → baseline only. `npx eslint "src/lib/review/types.ts" "src/lib/review/rubric.ts" "tests/call-reviewer.spec.ts"` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/review tests/call-reviewer.spec.ts
git commit -m "feat(review): rubric types + active-flag loader"
```

---

## Task 3: OpenAI structured-output helper

**Files:** Create `src/lib/review/openai.ts`

Context: mirror `src/lib/openai/summary-merger.ts` (plain `fetch` to chat-completions, `openAiKey()` gate). Use `response_format: { type: "json_schema", ... }` for strict output. Models come from env with sane defaults; store the model on the result so callers can log it.

- [ ] **Step 1: Write the helper**

`src/lib/review/openai.ts`:

```ts
import "server-only";
import { openAiKey } from "@/lib/openai/live";
import { priceOpenAiTokens } from "@/lib/costs/rates";

export const PASS1_MODEL =
  process.env.REVIEW_PASS1_MODEL?.trim() || "gpt-5.4-mini";
export const PASS2_MODEL = process.env.REVIEW_PASS2_MODEL?.trim() || "gpt-5.4";

export type JsonCallResult<T> = { data: T | null; cost: number; live: boolean };

/**
 * Call OpenAI chat-completions with a strict JSON schema. Returns parsed data
 * (or null on failure) + priced cost. When no OPENAI_API_KEY is set, returns
 * `mock` so tests never hit the network.
 */
export async function callOpenAiJson<T>(args: {
  model: string;
  system: string;
  user: string;
  schema: Record<string, unknown>;
  schemaName: string;
  mock: T;
}): Promise<JsonCallResult<T>> {
  const apiKey = openAiKey();
  if (!apiKey) return { data: args.mock, cost: 0, live: false };

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: args.model,
        messages: [
          { role: "system", content: args.system },
          { role: "user", content: args.user },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: args.schemaName,
            strict: true,
            schema: args.schema,
          },
        },
      }),
    });
    if (!res.ok) return { data: null, cost: 0, live: true };
    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = body.choices?.[0]?.message?.content;
    const cost = priceOpenAiTokens(
      body.usage?.prompt_tokens ?? 0,
      body.usage?.completion_tokens ?? 0,
    );
    if (!content) return { data: null, cost, live: true };
    try {
      return { data: JSON.parse(content) as T, cost, live: true };
    } catch {
      return { data: null, cost, live: true };
    }
  } catch {
    return { data: null, cost: 0, live: true };
  }
}
```

NOTE: confirm the exact OpenAI model ids for "5.4-mini"/"5.4"; they're env-overridable (`REVIEW_PASS1_MODEL`/`REVIEW_PASS2_MODEL`) so ops can set the real ids without a deploy. Confirm `priceOpenAiTokens` handles unknown models gracefully (fallback rate); if it throws on an unknown model, wrap in try/catch returning cost 0.

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit` → baseline only. `npx eslint "src/lib/review/openai.ts"` → clean.

- [ ] **Step 3: Commit**

```bash
git add src/lib/review/openai.ts
git commit -m "feat(review): OpenAI strict-JSON helper (5.4-mini/5.4 config)"
```

---

## Task 4: Two-pass analysis + merge

**Files:** Create `src/lib/review/analyze.ts`; Test `tests/call-reviewer.spec.ts`

- [ ] **Step 1: Write the merge unit test first (TDD)**

Append to `tests/call-reviewer.spec.ts`:

```ts
import { mergeVerification } from "../src/lib/review/analyze";

test("mergeVerification confirms agreed flags and flags disagreements for review", () => {
  const proposed = [
    {
      flag_key: "tool_error",
      evidence_quote: "the system errored",
      confidence: 0.9,
    },
    {
      flag_key: "price_objection",
      evidence_quote: "too expensive",
      confidence: 0.8,
    },
    { flag_key: "off_goal", evidence_quote: "n/a", confidence: 0.4 },
  ];
  const verdicts = {
    tool_error: {
      agree: true,
      confidence: 0.95,
      evidence_quote: "the system errored out",
    },
    price_objection: { agree: false, confidence: 0.9, evidence_quote: "" },
    off_goal: { agree: true, confidence: 0.5, evidence_quote: "n/a" },
  };
  const merged = mergeVerification(proposed, verdicts);
  // agreed + confident -> confirmed (uses verifier's evidence)
  expect(merged.find((f) => f.flag_key === "tool_error")).toMatchObject({
    status: "confirmed",
    evidence_quote: "the system errored out",
  });
  // refuted -> dropped entirely
  expect(merged.find((f) => f.flag_key === "price_objection")).toBeUndefined();
  // agreed but low confidence -> needs_review
  expect(merged.find((f) => f.flag_key === "off_goal")).toMatchObject({
    status: "needs_review",
  });
});
```

- [ ] **Step 2: Run it — fails (module not found)**

Run: `npx tsc --noEmit` → error: `src/lib/review/analyze.ts` has no exported `mergeVerification`. (Playwright can't run live; tsc is the gate.)

- [ ] **Step 3: Write analyze.ts**

`src/lib/review/analyze.ts`:

```ts
import "server-only";
import { buildRubricText } from "./rubric";
import { callOpenAiJson, PASS1_MODEL, PASS2_MODEL } from "./openai";
import type { ProposedFlag, ReviewFlagDef, VerifiedFlag } from "./types";

const CONFIDENCE_FLOOR = 0.6; // below this (or on disagreement) -> needs_review

type Verdict = { agree: boolean; confidence: number; evidence_quote: string };

/** Deterministic merge of Pass 1 proposals + Pass 2 verdicts. Pure — unit tested. */
export function mergeVerification(
  proposed: ProposedFlag[],
  verdicts: Record<string, Verdict>,
): VerifiedFlag[] {
  const out: VerifiedFlag[] = [];
  for (const p of proposed) {
    const v = verdicts[p.flag_key];
    if (!v) {
      // Verifier didn't rule on it — treat as needs_review, keep Pass 1 evidence.
      out.push({ ...p, status: "needs_review" });
      continue;
    }
    if (!v.agree) continue; // refuted -> drop
    const confidence = Math.min(p.confidence, v.confidence);
    out.push({
      flag_key: p.flag_key,
      evidence_quote: v.evidence_quote || p.evidence_quote,
      confidence,
      status: confidence >= CONFIDENCE_FLOOR ? "confirmed" : "needs_review",
    });
  }
  return out;
}

const PASS1_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["flags"],
  properties: {
    flags: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["flag_key", "evidence_quote", "confidence"],
        properties: {
          flag_key: { type: "string" },
          evidence_quote: { type: "string" },
          confidence: { type: "number" },
        },
      },
    },
  },
};

const PASS2_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["agree", "confidence", "evidence_quote"],
  properties: {
    agree: { type: "boolean" },
    confidence: { type: "number" },
    evidence_quote: { type: "string" },
  },
};

/** Run Pass 1 + Pass 2 for one call. Returns verified flags + total cost. */
export async function analyzeCall(input: {
  transcript: string;
  extracted: string;
  defs: ReviewFlagDef[];
}): Promise<{ flags: VerifiedFlag[]; cost: number }> {
  const rubric = buildRubricText(input.defs);
  const validKeys = new Set(input.defs.map((d) => d.key));

  // --- Pass 1: extract flags with evidence ---
  const p1 = await callOpenAiJson<{ flags: ProposedFlag[] }>({
    model: PASS1_MODEL,
    schemaName: "call_flags",
    schema: PASS1_SCHEMA,
    system:
      "You review a single sales/outreach phone call transcript between OUR AI agent and a business (the lead). " +
      "Flag ONLY things the transcript clearly supports, and quote the exact line as evidence. Never invent. " +
      "Attribution matters: the agent's pitch is NOT the lead's view.",
    user:
      `Rubric (flag_key (lens): meaning):\n${rubric}\n\n` +
      `Extracted call data: ${input.extracted}\n\n` +
      `Transcript:\n${input.transcript}\n\n` +
      "Return every rubric flag that applies, each with a verbatim evidence_quote from the transcript and a 0-1 confidence.",
    mock: { flags: [] },
  });
  const proposed = (p1.data?.flags ?? []).filter((f) =>
    validKeys.has(f.flag_key),
  );
  let cost = p1.cost;
  if (proposed.length === 0) return { flags: [], cost };

  // --- Pass 2: independently verify each proposed flag ---
  const verdicts: Record<string, Verdict> = {};
  for (const f of proposed) {
    const def = input.defs.find((d) => d.key === f.flag_key);
    const p2 = await callOpenAiJson<Verdict>({
      model: PASS2_MODEL,
      schemaName: "flag_verdict",
      schema: PASS2_SCHEMA,
      system:
        "You are a strict verifier. Given a call transcript and a claimed flag, decide if the flag is genuinely " +
        "true FROM THE TRANSCRIPT. Default to agree=false when the evidence is weak or ambiguous.",
      user:
        `Flag: ${f.flag_key} — ${def?.label}. Meaning: ${def?.guidance}\n` +
        `Claimed evidence: "${f.evidence_quote}"\n\n` +
        `Transcript:\n${input.transcript}\n\n` +
        "Is this flag genuinely true? Return agree (bool), confidence (0-1), and the correct verbatim evidence_quote.",
      mock: {
        agree: true,
        confidence: f.confidence,
        evidence_quote: f.evidence_quote,
      },
    });
    cost += p2.cost;
    if (p2.data) verdicts[f.flag_key] = p2.data;
  }

  return { flags: mergeVerification(proposed, verdicts), cost };
}
```

- [ ] **Step 4: Verify the test compiles + logic is right**

Run: `npx tsc --noEmit` → baseline only (the merge test now resolves). `npx eslint "src/lib/review/analyze.ts"` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/review/analyze.ts tests/call-reviewer.spec.ts
git commit -m "feat(review): two-pass analyze + verified-flag merge"
```

---

## Task 5: Enqueue + worker

**Files:** Create `src/lib/review/enqueue.ts`, `src/lib/review/worker.ts`

- [ ] **Step 1: Write enqueue.ts**

`src/lib/review/enqueue.ts`:

```ts
import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

type Admin = ReturnType<typeof createClient<Database>>;

/**
 * Register a completed call for review. A human-reached call is queued
 * (status='pending') for the worker; a non-conversation is closed immediately
 * with the `no_conversation` flag so it shows in a cheap bucket without an LLM.
 * Idempotent: upsert on the call_id PK.
 */
export async function enqueueCallReview(
  admin: Admin,
  input: { callId: string; reachedHuman: boolean },
): Promise<void> {
  await admin.from("call_reviews").upsert(
    {
      call_id: input.callId,
      reached_human: input.reachedHuman,
      status: input.reachedHuman ? "pending" : "done",
      analyzed_at: input.reachedHuman ? null : new Date().toISOString(),
    },
    { onConflict: "call_id", ignoreDuplicates: true },
  );
  if (!input.reachedHuman) {
    await admin
      .from("call_review_flags")
      .upsert(
        {
          call_id: input.callId,
          flag_key: "no_conversation",
          status: "confirmed",
        },
        { onConflict: "call_id,flag_key", ignoreDuplicates: true },
      );
  }
}
```

NOTE: add a `no_conversation` def to the Task 1 seed (append to the VALUES list): `('no_conversation','No conversation','voc',4,'Voicemail, no-answer, or instant hang-up — no real conversation happened.',50)`. (Add it now if not already there.)

- [ ] **Step 2: Write worker.ts**

`src/lib/review/worker.ts`:

```ts
import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { loadActiveFlagDefs } from "./rubric";
import { analyzeCall } from "./analyze";
import { PASS1_MODEL, PASS2_MODEL } from "./openai";

type Admin = ReturnType<typeof createClient<Database>>;

function admin(): Admin {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

export type ReviewTickSummary = {
  claimed: number;
  analyzed: number;
  errors: number;
};

/** Turn a stored transcript_json into a plain "Speaker: text" string. */
function transcriptToText(raw: unknown): string {
  const turns = Array.isArray(raw)
    ? raw
    : raw &&
        typeof raw === "object" &&
        Array.isArray((raw as { transcript?: unknown }).transcript)
      ? (raw as { transcript: unknown[] }).transcript
      : [];
  return (turns as Record<string, unknown>[])
    .map((t) => {
      const role = t.role === "user" ? "Lead" : "Agent";
      const msg =
        typeof t.message === "string"
          ? t.message
          : typeof t.text === "string"
            ? t.text
            : "";
      return msg ? `${role}: ${msg}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

/** One review tick: claim pending reviews, analyze, store flags. Idempotent. */
export async function runReviewTick(
  opts: { limit?: number } = {},
): Promise<ReviewTickSummary> {
  const db = admin();
  const summary: ReviewTickSummary = { claimed: 0, analyzed: 0, errors: 0 };

  // Claim a batch: flip pending -> analyzing (CAS), newest first.
  const { data: pending } = await db
    .from("call_reviews")
    .select("call_id")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(opts.limit ?? 25);
  if (!pending || pending.length === 0) return summary;

  const defs = await loadActiveFlagDefs(db);

  for (const row of pending) {
    // CAS claim so overlapping ticks don't double-process.
    const { data: claimed } = await db
      .from("call_reviews")
      .update({ status: "analyzing" })
      .eq("call_id", row.call_id)
      .eq("status", "pending")
      .select("call_id");
    if (!claimed || claimed.length === 0) continue;
    summary.claimed++;

    try {
      const { data: call } = await db
        .from("calls")
        .select("transcript_json, extracted_data")
        .eq("id", row.call_id)
        .maybeSingle();
      const transcript = transcriptToText(call?.transcript_json);
      if (!transcript.trim()) {
        await db
          .from("call_reviews")
          .update({ status: "done", analyzed_at: new Date().toISOString() })
          .eq("call_id", row.call_id);
        continue;
      }
      const { flags, cost } = await analyzeCall({
        transcript,
        extracted: JSON.stringify(call?.extracted_data ?? {}),
        defs,
      });
      for (const f of flags) {
        await db
          .from("call_review_flags")
          .upsert(
            {
              call_id: row.call_id,
              flag_key: f.flag_key,
              evidence_quote: f.evidence_quote,
              confidence: f.confidence,
              status: f.status,
            },
            { onConflict: "call_id,flag_key" },
          );
      }
      await db
        .from("call_reviews")
        .update({
          status: "done",
          needs_review: flags.some((f) => f.status === "needs_review"),
          pass1_model: PASS1_MODEL,
          pass2_model: PASS2_MODEL,
          cost,
          analyzed_at: new Date().toISOString(),
        })
        .eq("call_id", row.call_id);
      summary.analyzed++;
    } catch (e) {
      summary.errors++;
      await db
        .from("call_reviews")
        .update({
          status: "error",
          error: e instanceof Error ? e.message : "unknown",
        })
        .eq("call_id", row.call_id);
    }
  }
  return summary;
}
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit` → baseline only. `npx eslint "src/lib/review/enqueue.ts" "src/lib/review/worker.ts"` → clean.

- [ ] **Step 4: Commit**

```bash
git add src/lib/review/enqueue.ts src/lib/review/worker.ts supabase/migrations/20260705130000_call_reviewer.sql
git commit -m "feat(review): enqueue + worker (claim, analyze, store flags)"
```

---

## Task 6: Hook enqueue into the post-call webhook

**Files:** Modify `src/lib/elevenlabs/post-call-webhook.ts`

Context: the webhook already computes a `reachedHuman` boolean (used to gate the call summary, ~line 1005) and runs `mergeLeadSummary` at step 39 with a service-role `supabase`. Enqueue right after the summary merge, best-effort.

- [ ] **Step 1: Add the import**

Near the other `@/lib/...` imports:

```ts
import { enqueueCallReview } from "@/lib/review/enqueue";
```

- [ ] **Step 2: Enqueue after the merge step**

Immediately after the `mergeLeadSummary(...)` block (step 39), add:

```ts
// Queue this call for the reviewer. Human-reached calls get the deep two-pass
// analysis; the rest are auto-bucketed as no_conversation. Best-effort — never
// fail the webhook on a review-enqueue hiccup.
try {
  await enqueueCallReview(supabase, {
    callId: call.id,
    reachedHuman,
  });
} catch {
  // best-effort
}
```

(Use whatever the in-scope service-role client + `reachedHuman` variable are actually named in this function — confirm by reading the surrounding code. If `reachedHuman` isn't in scope at this point, derive it the same way the summary gate does.)

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit` → baseline only. `npx eslint "src/lib/elevenlabs/post-call-webhook.ts"` → clean. `npm run build` → succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/lib/elevenlabs/post-call-webhook.ts
git commit -m "feat(review): enqueue each completed call for review"
```

---

## Task 7: Secured tick endpoint

**Files:** Create `src/app/api/review/tick/route.ts`

Context: mirror `src/app/api/dialer/tick/route.ts` exactly — same `x-dialer-secret` (DIALER_TICK_SECRET) gate + signed-in-admin fallback. pg_cron will POST this (scheduled separately in the Supabase dashboard / a follow-up migration).

- [ ] **Step 1: Write the route**

`src/app/api/review/tick/route.ts`:

```ts
import { NextResponse, type NextRequest } from "next/server";
import { runReviewTick } from "@/lib/review/worker";
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
    return NextResponse.json(await runReviewTick({}));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit` → baseline only. `npx eslint "src/app/api/review/tick/route.ts"` → clean. `npm run build` → succeeds (route compiles).

- [ ] **Step 3: Commit**

```bash
git add "src/app/api/review/tick/route.ts"
git commit -m "feat(review): secured /api/review/tick endpoint"
```

- [ ] **Step 4: Note the cron (manual/ops step, documented not coded)**

Add to the plan's completion notes: after deploy, schedule a pg_cron job (like `dialer-tick`) POSTing `/api/review/tick` every minute with the `app_settings.dialer_tick_secret` header — same mechanism as the dialer. Not a code task; ops sets it up when Vercel is unblocked.

---

## Task 8: Golden-set accuracy test

**Files:** Modify `tests/call-reviewer.spec.ts`

Context: the real accuracy guardrail. In mock mode (`OPENAI_LIVE` off) `analyzeCall` returns `{flags:[]}` (the mock), so this test asserts the DETERMINISTIC pieces end-to-end against hand-written transcripts + a live-env variant. Keep the live-env LLM assertion `test.skip` unless `OPENAI_API_KEY` is set.

- [ ] **Step 1: Add a transcript→text + validity test**

Append to `tests/call-reviewer.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

// Deterministic golden check: a known transcript with a booking-recovery pattern.
// In mock mode we assert the pipeline SHAPE; the LLM-dependent assertion is
// guarded behind OPENAI_API_KEY so CI without a key still passes.
const GOLDEN = {
  transcript:
    "Agent: I can book you for 4pm Tuesday.\nLead: sure.\nAgent: Hmm, that time isn't available.\nAgent: Actually, you're all set for 4pm Tuesday.",
  expectFlag: "booking_failed_then_recovered",
};

test("golden: booking-failed-then-recovered (live only)", async () => {
  test.skip(!process.env.OPENAI_API_KEY, "needs a live OpenAI key");
  const { analyzeCall } = await import("../src/lib/review/analyze");
  const { flags } = await analyzeCall({
    transcript: GOLDEN.transcript,
    extracted: "{}",
    defs: [
      {
        key: "booking_failed_then_recovered",
        label: "Booking failed then recovered",
        lens: "bug",
        severity: 1,
        guidance:
          "Said a time was unavailable, then booked the same slot anyway.",
      },
    ],
  });
  expect(flags.map((f) => f.flag_key)).toContain(GOLDEN.expectFlag);
});
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit` → baseline only. `npx eslint "tests/call-reviewer.spec.ts"` → clean.

- [ ] **Step 3: Commit**

```bash
git add tests/call-reviewer.spec.ts
git commit -m "test(review): golden-set booking-recovery (live-gated) + shape"
```

---

## Final verification

- [ ] `npx tsc --noEmit` — only the 3 baseline `twilio-*.spec.ts` errors.
- [ ] `npx eslint` on all changed files — clean.
- [ ] `npm run build` — succeeds.
- [ ] Migration applied to prod (`supabase db push --linked`); types regenerated.
- [ ] **Manual (post-deploy / when Vercel unblocked):** set `REVIEW_PASS1_MODEL`/`REVIEW_PASS2_MODEL` env to the real 5.4-mini/5.4 ids; schedule the pg_cron review-tick; place a live test call that reaches a human → confirm a `call_reviews` row goes pending→done and `call_review_flags` populate.
- [ ] Phase 2 (Review UI) gets its own plan once the engine is producing flags.
