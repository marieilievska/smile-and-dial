# Call Review → Prompt Improvement Suggestions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Human-approved call-review findings feed on-demand, AI-drafted, anchored prompt edits that Marija reviews (and can reword) before one click applies them to the live ElevenLabs agent — with freshness checks, an auto prompt-log entry, and revert.

**Architecture:** One additive migration (a `review_prompt_suggestions` table + human-curation columns on `call_review_flags`). A server-only lib module (`src/lib/review/suggest.ts`) holds the pure anchored-edit engine (unit-tested), the OpenAI drafting call (reusing `callOpenAiJson`), and the prompt read/write helpers (reusing `fetchElevenLabsAgentPrompt` + a new prompt-only ElevenLabs PATCH). Server actions in `src/lib/review/actions.ts` gate everything admin-only. The Reporting → Call review tab gets a "Suggest prompt fix" button per bucket and a third "Prompt improvements" section.

**Tech Stack:** Next.js App Router (server actions + RSC), Supabase (service-role admin client + RLS), OpenAI chat-completions strict JSON (existing `callOpenAiJson`), ElevenLabs Convai agents API, vitest (unit), Playwright (e2e contract), Tailwind + shadcn/ui.

**Branch:** `feat/call-review-prompt-suggestions` (already exists, spec committed).

**Spec:** `docs/superpowers/specs/2026-07-16-call-review-prompt-suggestions-design.md` — read it first.

**Repo rules that bind every task:**

- This repo's Next.js has breaking changes — if you write any Next-specific code beyond the patterns you see in neighboring files, check `node_modules/next/dist/docs/` first. Every pattern this plan uses (server actions with `"use server"`, `revalidatePath`, RSC data fetching, client components with `useTransition`) is copied from working neighbors.
- The trim rule (keeps freshness checks deterministic): every prompt string that is stored, compared, or written is `.trim()`ed at the boundary. `fetchElevenLabsAgentPrompt` already returns trimmed text; `resolveCurrentAgentPrompt` trims the wizard path; generation stores `based_on_prompt`/`proposed_prompt` trimmed; apply recomputes and writes the trimmed result.
- Commits: end every commit message with the trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` (shown once below; apply to all).

---

## Task 1: Migration — suggestions table + curation columns

**Files:**

- Create: `supabase/migrations/20260716120000_review_prompt_suggestions.sql`

The migration is ADDITIVE ONLY (new table, new nullable columns) so it is safe to `supabase db push --linked` before the code deploys. Do NOT push it during this task — pushing happens in Task 13 (ship), right before merge.

- [ ] **Step 1: Write the migration**

```sql
-- Prompt improvement suggestions: human-approved call-review findings feed an
-- on-demand, AI-drafted, anchored edit to the agent's system prompt. A human
-- reviews the exact diff before anything is applied to the live agent.

-- 1. The suggestions themselves. based_on_prompt is the exact live prompt the
--    edits were drafted against (also the freshness-check baseline and the
--    revert target); proposed_prompt is that prompt with the edits applied.
create table if not exists public.review_prompt_suggestions (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents(id) on delete cascade,
  flag_key text not null references public.review_flag_defs(key),
  based_on_prompt text not null,
  proposed_prompt text not null,
  -- [{type: 'replace'|'insert_after'|'append', anchor: text, text: text}]
  edits jsonb not null,
  rationale text not null,
  summary text not null,
  example_count int not null default 0,
  status text not null default 'proposed', -- proposed | applied | dismissed | reverted
  model text,
  cost numeric not null default 0,
  created_at timestamptz not null default now(),
  decided_by uuid references public.profiles(id) on delete set null,
  decided_at timestamptz,
  applied_at timestamptz,
  reverted_at timestamptz
);

create index if not exists review_prompt_suggestions_status_idx
  on public.review_prompt_suggestions (status, created_at desc);

alter table public.review_prompt_suggestions enable row level security;

-- Admin-only read via RLS; writes go through service-role server actions
-- (matching call_reviews / agent_prompt_log).
create policy "review_prompt_suggestions_admin_all"
  on public.review_prompt_suggestions
  for all to authenticated
  using (public.is_admin((select auth.uid())))
  with check (public.is_admin((select auth.uid())));

-- 2. Record WHO curated a flag and WHEN (the AI also writes status='confirmed',
--    so status alone can't tell a human decision apart), plus which suggestion
--    consumed the flag as an example (so one example never feeds two
--    suggestions; cleared when that suggestion is dismissed or reverted).
alter table public.call_review_flags
  add column if not exists curated_by uuid references public.profiles(id) on delete set null,
  add column if not exists curated_at timestamptz,
  add column if not exists suggestion_id uuid references public.review_prompt_suggestions(id) on delete set null;

-- The "available approved examples" pool is always queried with exactly this
-- shape: confirmed + human-curated + not yet consumed.
create index if not exists call_review_flags_suggest_idx
  on public.call_review_flags (flag_key, status)
  where curated_at is not null and suggestion_id is null;
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260716120000_review_prompt_suggestions.sql
git commit -m "feat(review): migration for prompt improvement suggestions

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Hand-add the new types to database.types.ts

**Files:**

- Modify: `src/lib/supabase/database.types.ts` (types are hand-maintained in this repo)

- [ ] **Step 1: Extend `call_review_flags`**

Find the `call_review_flags` block (around line 1456). Add the three new fields to `Row`, `Insert`, and `Update` (alphabetical position shown; keep `Relationships: []` as-is — no PostgREST joins are used on this table):

In `Row`:

```ts
call_id: string;
confidence: number | null;
created_at: string;
curated_at: string | null;
curated_by: string | null;
evidence_quote: string | null;
flag_key: string;
id: string;
status: string;
suggestion_id: string | null;
```

In `Insert` and `Update`, the same three fields, all optional:

```ts
          curated_at?: string | null;
          curated_by?: string | null;
          suggestion_id?: string | null;
```

(`Insert` keeps its existing required `call_id`/`flag_key`; `Update` keeps everything optional.)

- [ ] **Step 2: Add the `review_prompt_suggestions` table block**

Insert alphabetically among the `Tables` (right after the `review_flag_defs` block if present, otherwise near `call_reviews` — match the file's existing alphabetical-ish ordering):

```ts
      review_prompt_suggestions: {
        Row: {
          agent_id: string;
          applied_at: string | null;
          based_on_prompt: string;
          cost: number;
          created_at: string;
          decided_at: string | null;
          decided_by: string | null;
          edits: Json;
          example_count: number;
          flag_key: string;
          id: string;
          model: string | null;
          proposed_prompt: string;
          rationale: string;
          reverted_at: string | null;
          status: string;
          summary: string;
        };
        Insert: {
          agent_id: string;
          applied_at?: string | null;
          based_on_prompt: string;
          cost?: number;
          created_at?: string;
          decided_at?: string | null;
          decided_by?: string | null;
          edits: Json;
          example_count?: number;
          flag_key: string;
          id?: string;
          model?: string | null;
          proposed_prompt: string;
          rationale: string;
          reverted_at?: string | null;
          status?: string;
          summary: string;
        };
        Update: {
          agent_id?: string;
          applied_at?: string | null;
          based_on_prompt?: string;
          cost?: number;
          created_at?: string;
          decided_at?: string | null;
          decided_by?: string | null;
          edits?: Json;
          example_count?: number;
          flag_key?: string;
          id?: string;
          model?: string | null;
          proposed_prompt?: string;
          rationale?: string;
          reverted_at?: string | null;
          status?: string;
          summary?: string;
        };
        Relationships: [];
      };
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean (no errors).

- [ ] **Step 4: Commit**

```bash
git add src/lib/supabase/database.types.ts
git commit -m "feat(review): types for review_prompt_suggestions + flag curation columns"
```

(Include the Co-Authored-By trailer, as in Task 1 — same for every commit below.)

---

## Task 3: The anchored-edit engine (pure, TDD)

**Files:**

- Modify: `src/lib/review/types.ts` (add `PromptEdit`)
- Create: `src/lib/review/suggest.ts`
- Test: `tests/prompt-suggest.unit.test.ts`

This is the safety heart of the feature: the AI can only express changes as anchored operations, and this module rejects anything that doesn't match the prompt exactly once. Validation happens against the WORKING text as edits apply sequentially (edit 2's anchor is checked against the result of edit 1) — deterministic and safe.

- [ ] **Step 1: Add the `PromptEdit` type to `src/lib/review/types.ts`**

Append to the end of the file (it has no `"server-only"` import, so client components and vitest can both use it):

```ts
/** One anchored edit to an agent's system prompt. The AI may ONLY express its
 *  change this way — everything outside the named anchor is untouchable.
 *   - replace:      swap the (unique, verbatim) anchor passage for `text`
 *   - insert_after: insert `"\n" + text` right after the anchor passage
 *   - append:       add `text` at the very end (anchor is ignored; send "")
 */
export type PromptEdit = {
  type: "replace" | "insert_after" | "append";
  anchor: string;
  text: string;
};
```

- [ ] **Step 2: Write the failing unit tests**

Create `tests/prompt-suggest.unit.test.ts`:

```ts
import { test, expect } from "vitest";
import { applyPromptEdits } from "../src/lib/review/suggest";
import type { PromptEdit } from "../src/lib/review/types";

const PROMPT = [
  "You are Sam, a friendly caller.",
  "Always greet the person by name.",
  "Never mention pricing unless asked.",
].join("\n");

test("replace swaps exactly the anchored passage and nothing else", () => {
  const edits: PromptEdit[] = [
    {
      type: "replace",
      anchor: "Always greet the person by name.",
      text: "Always greet the person by name and wait for their reply.",
    },
  ];
  const r = applyPromptEdits(PROMPT, edits);
  expect(r.error).toBeNull();
  expect(r.result).toBe(
    [
      "You are Sam, a friendly caller.",
      "Always greet the person by name and wait for their reply.",
      "Never mention pricing unless asked.",
    ].join("\n"),
  );
});

test("insert_after adds a new line right after the anchor", () => {
  const r = applyPromptEdits(PROMPT, [
    {
      type: "insert_after",
      anchor: "You are Sam, a friendly caller.",
      text: "Speak slowly and clearly.",
    },
  ]);
  expect(r.error).toBeNull();
  expect(r.result).toContain(
    "You are Sam, a friendly caller.\nSpeak slowly and clearly.\nAlways greet",
  );
});

test("append adds text at the end, separated by a blank line", () => {
  const r = applyPromptEdits(PROMPT, [
    { type: "append", anchor: "", text: "NEW RULE: never talk over the lead." },
  ]);
  expect(r.error).toBeNull();
  expect(r.result).toBe(`${PROMPT}\n\nNEW RULE: never talk over the lead.`);
});

test("multiple edits apply in order against the working text", () => {
  const r = applyPromptEdits(PROMPT, [
    {
      type: "replace",
      anchor: "friendly caller",
      text: "warm, patient caller",
    },
    { type: "append", anchor: "", text: "Always confirm the callback time." },
  ]);
  expect(r.error).toBeNull();
  expect(r.result).toContain("warm, patient caller");
  expect(r.result?.endsWith("Always confirm the callback time.")).toBe(true);
});

test("an anchor that is not found is rejected", () => {
  const r = applyPromptEdits(PROMPT, [
    { type: "replace", anchor: "This text is not in the prompt", text: "x" },
  ]);
  expect(r.result).toBeNull();
  expect(r.error).toContain("not found");
});

test("an ambiguous anchor (appears twice) is rejected", () => {
  const twice = "Say hi.\nSay hi.";
  const r = applyPromptEdits(twice, [
    { type: "replace", anchor: "Say hi.", text: "Say hello." },
  ]);
  expect(r.result).toBeNull();
  expect(r.error).toContain("more than once");
});

test("empty replacement text is rejected (no silent deletions)", () => {
  const r = applyPromptEdits(PROMPT, [
    {
      type: "replace",
      anchor: "Never mention pricing unless asked.",
      text: "  ",
    },
  ]);
  expect(r.result).toBeNull();
  expect(r.error).toContain("empty");
});

test("a replace/insert edit with an empty anchor is rejected", () => {
  const r = applyPromptEdits(PROMPT, [
    { type: "replace", anchor: "", text: "x" },
  ]);
  expect(r.result).toBeNull();
  expect(r.error).toContain("anchor");
});

test("zero edits and too many edits are rejected", () => {
  expect(applyPromptEdits(PROMPT, []).error).toContain("No edits");
  const five: PromptEdit[] = Array.from({ length: 5 }, () => ({
    type: "append" as const,
    anchor: "",
    text: "x",
  }));
  expect(applyPromptEdits(PROMPT, five).error).toContain("more than");
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/prompt-suggest.unit.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/review/suggest'` (the module doesn't exist yet).

- [ ] **Step 4: Create `src/lib/review/suggest.ts` with the engine**

```ts
import "server-only";

import type { PromptEdit } from "./types";

/** Never more than this many anchored edits per suggestion — one targeted
 *  change may need a couple of operations, but a long list means the model is
 *  rewriting, not editing. */
export const MAX_SUGGESTION_EDITS = 4;

function clip(s: string): string {
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

/**
 * Validate + apply anchored edits in one pass. Edits apply sequentially, each
 * validated against the WORKING text (so a later anchor may target text an
 * earlier edit produced). Returns the edited prompt, or a human-readable error
 * (also fed back to the model on its one retry). The AI cannot touch anything
 * outside its anchors by construction — the rest is copied byte-for-byte.
 */
export function applyPromptEdits(
  prompt: string,
  edits: PromptEdit[],
): { result: string | null; error: string | null } {
  if (edits.length === 0) {
    return { result: null, error: "No edits were proposed." };
  }
  if (edits.length > MAX_SUGGESTION_EDITS) {
    return {
      result: null,
      error: `No more than ${MAX_SUGGESTION_EDITS} edits are allowed.`,
    };
  }
  let out = prompt;
  for (const e of edits) {
    if (!e.text.trim()) {
      return { result: null, error: "An edit has empty replacement text." };
    }
    if (e.type === "append") {
      out = `${out.trimEnd()}\n\n${e.text.trim()}`;
      continue;
    }
    if (!e.anchor.trim()) {
      return {
        result: null,
        error: `A ${e.type} edit is missing its anchor text.`,
      };
    }
    const first = out.indexOf(e.anchor);
    if (first === -1) {
      return {
        result: null,
        error: `Anchor text was not found verbatim in the prompt: "${clip(e.anchor)}"`,
      };
    }
    if (out.indexOf(e.anchor, first + e.anchor.length) !== -1) {
      return {
        result: null,
        error: `Anchor text appears more than once in the prompt: "${clip(e.anchor)}"`,
      };
    }
    out =
      e.type === "replace"
        ? out.slice(0, first) + e.text + out.slice(first + e.anchor.length)
        : out.slice(0, first + e.anchor.length) +
          "\n" +
          e.text +
          out.slice(first + e.anchor.length);
  }
  return { result: out, error: null };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/prompt-suggest.unit.test.ts`
Expected: PASS (9 tests). Also run `npm run test:unit` to confirm the existing unit suite still passes.

- [ ] **Step 6: Commit**

```bash
git add src/lib/review/types.ts src/lib/review/suggest.ts tests/prompt-suggest.unit.test.ts
git commit -m "feat(review): anchored prompt-edit engine (validate + apply, pure)"
```

---

## Task 4: The AI drafting call (TDD against the mock path)

**Files:**

- Modify: `src/lib/review/suggest.ts`
- Test: `tests/prompt-suggest.unit.test.ts`

Reuses `callOpenAiJson` (strict JSON schema; returns the `mock` argument when `OPENAI_API_KEY` is unset, so dev/tests are free). One automatic retry when the model's anchors don't validate.

- [ ] **Step 1: Write the failing test**

Append to `tests/prompt-suggest.unit.test.ts`:

```ts
import { draftPromptSuggestion } from "../src/lib/review/suggest";

// Mock-path shape test (callOpenAiJson returns its mock when no OPENAI_API_KEY).
// Guarded like the golden test in call-reviewer.unit.test.ts so a shell with a
// real key doesn't spend money on a unit run.
test("draftPromptSuggestion returns a validated draft in mock mode", async () => {
  if (process.env.OPENAI_API_KEY) return;
  const r = await draftPromptSuggestion({
    prompt: "You are Sam.\nAlways be polite.",
    bucket: {
      key: "talked_over",
      label: "Talked over the lead",
      guidance: "Agent interrupts.",
    },
    examples: [{ evidenceQuote: "Agent: —sorry, go ahead" }],
  });
  expect(r.error).toBeNull();
  expect(r.draft).not.toBeNull();
  expect(r.draft!.edits.length).toBeGreaterThan(0);
  // The mock is an append, so the proposed prompt keeps the original intact.
  expect(r.draft!.proposedPrompt.startsWith("You are Sam.")).toBe(true);
  expect(r.draft!.proposedPrompt.length).toBeGreaterThan(
    "You are Sam.\nAlways be polite.".length,
  );
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/prompt-suggest.unit.test.ts`
Expected: FAIL — `draftPromptSuggestion` is not exported.

- [ ] **Step 3: Implement drafting in `src/lib/review/suggest.ts`**

Add to the imports at the top:

```ts
import { callOpenAiJson, PASS2_MODEL } from "./openai";
```

Append to the file:

```ts
/** Cap the number of approved examples fed into one suggestion. */
export const MAX_SUGGESTION_EXAMPLES = 20;

export type SuggestionExample = { evidenceQuote: string | null };

export type SuggestionDraft = {
  rationale: string;
  summary: string;
  edits: PromptEdit[];
  /** based-on prompt with the edits applied (validated), trimmed. */
  proposedPrompt: string;
};

const SUGGEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["rationale", "summary", "edits"],
  properties: {
    rationale: { type: "string" },
    summary: { type: "string" },
    edits: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "anchor", "text"],
        properties: {
          type: { type: "string", enum: ["replace", "insert_after", "append"] },
          anchor: { type: "string" },
          text: { type: "string" },
        },
      },
    },
  },
};

const SUGGEST_SYSTEM =
  "You improve the SYSTEM PROMPT of an AI phone-calling agent, like a careful, conservative prompt engineer. " +
  "You get the agent's current prompt plus verified examples of ONE recurring mistake from real calls. " +
  "Propose the SMALLEST edit that fixes that one mistake pattern.\n" +
  "Hard rules:\n" +
  '- Express your change ONLY as the edit operations: "replace" (swap one existing passage for improved text), ' +
  '"insert_after" (add new text right after an existing passage), "append" (add a new rule at the very end).\n' +
  "- anchor must be COPIED VERBATIM from the prompt (exact characters), must appear exactly once in it, and should " +
  'end at a natural boundary (end of a sentence or line). For "append", set anchor to "".\n' +
  "- Never rewrite, reorder, shorten, or delete anything you were not explicitly targeting. Keep the prompt's " +
  "voice, formatting, and structure.\n" +
  "- Preserve every {{dynamic_variable}} placeholder exactly.\n" +
  "- Prefer ONE edit; never more than 4. text must never be empty.\n" +
  "- rationale: 2-4 plain-English sentences a non-developer can read — what pattern the examples show and how the " +
  "edit fixes it. summary: one short line (under ~90 chars) naming the change, " +
  'e.g. "Added a rule: never talk over the lead".';

/**
 * Draft ONE anchored prompt edit from approved examples. Validates the model's
 * anchors mechanically; on failure retries once with the validator's feedback;
 * a second failure returns a friendly error (nothing is saved by callers).
 * With no OPENAI_API_KEY the mock (a safe append) flows through validation.
 */
export async function draftPromptSuggestion(input: {
  prompt: string;
  bucket: { key: string; label: string; guidance: string };
  examples: SuggestionExample[];
}): Promise<{
  draft: SuggestionDraft | null;
  cost: number;
  error: string | null;
}> {
  const examplesText = input.examples
    .slice(0, MAX_SUGGESTION_EXAMPLES)
    .map((e, i) => {
      const q = (e.evidenceQuote ?? "").trim();
      return `${i + 1}. "${q ? clipQuote(q) : "(no quote recorded)"}"`;
    })
    .join("\n");
  const userBase =
    "AGENT SYSTEM PROMPT (current, verbatim between the markers):\n" +
    `<<<PROMPT\n${input.prompt}\nPROMPT>>>\n\n` +
    `RECURRING MISTAKE to fix: ${input.bucket.label} — ${input.bucket.guidance}\n\n` +
    `Verified examples from real calls (transcript quotes):\n${examplesText}\n\n` +
    "Propose the smallest anchored edit(s) to the system prompt that would prevent this mistake on future calls.";

  let feedback = "";
  let cost = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await callOpenAiJson<{
      rationale: string;
      summary: string;
      edits: PromptEdit[];
    }>({
      model: PASS2_MODEL,
      schemaName: "prompt_suggestion",
      schema: SUGGEST_SCHEMA,
      system: SUGGEST_SYSTEM,
      user: userBase + feedback,
      mock: {
        rationale:
          "Mock rationale: added an explicit rule for the recurring mistake.",
        summary: "Mock prompt improvement",
        edits: [
          {
            type: "append",
            anchor: "",
            text: "MOCK RULE: avoid the flagged mistake.",
          },
        ],
      },
    });
    cost += res.cost;
    if (!res.data) {
      return {
        draft: null,
        cost,
        error: "The AI didn't return a usable suggestion. Try again.",
      };
    }
    const applied = applyPromptEdits(input.prompt, res.data.edits);
    if (applied.result) {
      return {
        draft: { ...res.data, proposedPrompt: applied.result.trim() },
        cost,
        error: null,
      };
    }
    if (!res.live) return { draft: null, cost, error: applied.error }; // mock can't improve on retry
    feedback =
      `\n\nYour previous proposal was rejected by the validator: ${applied.error} ` +
      "Remember: anchor must be copied character-for-character from the prompt above and must appear exactly once.";
  }
  return {
    draft: null,
    cost,
    error:
      "The AI couldn't anchor its change to the current prompt. Try generating again.",
  };
}

function clipQuote(s: string): string {
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/prompt-suggest.unit.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/review/suggest.ts tests/prompt-suggest.unit.test.ts
git commit -m "feat(review): AI drafting call for prompt suggestions (validated, one retry)"
```

---

## Task 5: Prompt-only ElevenLabs write

**Files:**

- Modify: `src/lib/elevenlabs/agents.ts` (append one function, after `fetchElevenLabsAgentPrompt` around line 774)

Read-modify-write following `applyConnectedAgentIntegration`'s conventions: GET the full agent config, change ONLY `conversation_config.agent.prompt.prompt`, PATCH the full `conversation_config` back. `platform_settings` is omitted entirely (untouched). Mocked off-live. A rejected PATCH is a benign no-op — never partial state.

- [ ] **Step 1: Append the function**

```ts
/** Update ONLY an agent's system-prompt text on ElevenLabs. Read-modify-write:
 *  GET the full config, swap conversation_config.agent.prompt.prompt, PATCH the
 *  full conversation_config back (platform_settings untouched by omission) so
 *  voice/tools/webhooks are preserved byte-for-byte. Backs the Reporting
 *  "Prompt improvements" apply/revert. Mocked (no-op) unless ELEVENLABS_LIVE.
 */
export async function updateElevenLabsAgentPrompt(
  agentId: string,
  newPrompt: string,
): Promise<{ error: string | null }> {
  if (!isLive()) return { error: null };
  const apiKey = fetchApiKey();
  if (!apiKey) return { error: "ElevenLabs API key isn't set." };

  let current: { conversation_config?: Record<string, unknown> };
  try {
    const res = await fetch(
      `${ELEVENLABS_API}/${encodeURIComponent(agentId)}`,
      { headers: { "xi-api-key": apiKey } },
    );
    if (!res.ok) return { error: `ElevenLabs lookup failed (${res.status}).` };
    current = (await res.json()) as typeof current;
  } catch {
    return { error: "ElevenLabs lookup failed." };
  }

  const cc = (current.conversation_config ?? {}) as Record<string, unknown>;
  const agent = (cc.agent ?? {}) as Record<string, unknown>;
  const prompt = { ...(agent.prompt ?? {}) } as Record<string, unknown>;
  prompt.prompt = newPrompt;
  // The API rejects a body carrying BOTH the legacy inline `tools` array and
  // `tool_ids`. Echoing the GET body back can trip that on some agents — keep
  // whichever is actually populated.
  if (
    Array.isArray(prompt.tool_ids) &&
    (prompt.tool_ids as unknown[]).length > 0 &&
    "tools" in prompt
  ) {
    delete prompt.tools;
  }

  try {
    const res = await fetch(
      `${ELEVENLABS_API}/${encodeURIComponent(agentId)}`,
      {
        method: "PATCH",
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          conversation_config: { ...cc, agent: { ...agent, prompt } },
        }),
      },
    );
    if (!res.ok)
      return { error: `ElevenLabs prompt update failed (${res.status}).` };
    return { error: null };
  } catch {
    return { error: "ElevenLabs prompt update failed." };
  }
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `npx tsc --noEmit` — expected clean.

```bash
git add src/lib/elevenlabs/agents.ts
git commit -m "feat(elevenlabs): prompt-only agent PATCH (read-modify-write)"
```

---

## Task 6: Prompt resolve/write + example-pool helpers

**Files:**

- Modify: `src/lib/review/suggest.ts`

Three server helpers the actions will share. `resolveCurrentAgentPrompt` is the single source of "what is the agent's prompt right now" (generation, freshness checks). `writeAgentPrompt` is the single write path (apply AND revert), ElevenLabs-first. `loadApprovedFlags` pools the human-approved, unconsumed examples for one (bucket, agent).

- [ ] **Step 1: Add imports to `src/lib/review/suggest.ts`**

```ts
import { createClient } from "@supabase/supabase-js";

import {
  normalizeDataCollection,
  normalizeEvaluation,
} from "@/lib/agents/data-collection";
import type { ToolsEnabled } from "@/lib/agents/prompt";
import {
  fetchElevenLabsAgentPrompt,
  syncAgentToElevenLabs,
  updateElevenLabsAgentPrompt,
} from "@/lib/elevenlabs/agents";
import type { Database } from "@/lib/supabase/database.types";

import { chunk } from "./chunk";
```

- [ ] **Step 2: Append the helpers**

```ts
type Admin = ReturnType<typeof createClient<Database>>;

/** Everything the prompt read/write paths need about an agent, in one select.
 *  Kept as ONE string literal (no concatenation) so supabase-js can parse it
 *  and type the result — a computed string degrades the row typing. */
export const AGENT_PROMPT_COLUMNS =
  "id, name, externally_managed, elevenlabs_agent_id, system_prompt, voice_id, ai_model, prompt_goal, extra_data_collection, extra_evaluation, tools_enabled";

export type AgentPromptRow = Pick<
  Database["public"]["Tables"]["agents"]["Row"],
  | "id"
  | "name"
  | "externally_managed"
  | "elevenlabs_agent_id"
  | "system_prompt"
  | "voice_id"
  | "ai_model"
  | "prompt_goal"
  | "extra_data_collection"
  | "extra_evaluation"
  | "tools_enabled"
>;

/** The agent's CURRENT full prompt, trimmed — live from ElevenLabs for
 *  externally-managed agents (cache deliberately bypassed: suggestions and
 *  freshness checks must see the real text, and resolveAgentReviewPrompt's
 *  INSTRUCTIONS_CAP truncation must NOT apply — anchors need the full prompt),
 *  or the local system_prompt for wizard agents. */
export async function resolveCurrentAgentPrompt(
  agent: AgentPromptRow,
): Promise<{ prompt: string | null; error: string | null }> {
  if (!agent.externally_managed) {
    const p = agent.system_prompt?.trim() || null;
    return p
      ? { prompt: p, error: null }
      : { prompt: null, error: "This agent has no system prompt saved." };
  }
  if (!agent.elevenlabs_agent_id) {
    return { prompt: null, error: "This agent has no ElevenLabs id." };
  }
  const p = await fetchElevenLabsAgentPrompt(agent.elevenlabs_agent_id);
  return p
    ? { prompt: p, error: null }
    : { prompt: null, error: "Couldn't read the live prompt from ElevenLabs." };
}

/** Write a new prompt to the agent — ElevenLabs FIRST, local bookkeeping only
 *  after it succeeds (a failed write changes nothing anywhere). Externally
 *  managed: prompt-only PATCH + refresh the reviewer's playbook cache. Wizard:
 *  full re-sync with the new prompt (same pipeline as the agent editor), then
 *  save system_prompt locally (the reviewer reads it directly). */
export async function writeAgentPrompt(
  admin: Admin,
  agent: AgentPromptRow,
  newPrompt: string,
): Promise<{ error: string | null }> {
  if (agent.externally_managed) {
    if (!agent.elevenlabs_agent_id) {
      return { error: "This agent has no ElevenLabs id." };
    }
    const r = await updateElevenLabsAgentPrompt(
      agent.elevenlabs_agent_id,
      newPrompt,
    );
    if (r.error) return r;
    await admin
      .from("agents")
      .update({
        review_prompt: newPrompt,
        review_prompt_at: new Date().toISOString(),
      })
      .eq("id", agent.id);
    return { error: null };
  }
  const sync = await syncAgentToElevenLabs(
    {
      name: agent.name,
      systemPrompt: newPrompt,
      voiceId: agent.voice_id,
      aiModel: agent.ai_model,
      goal: agent.prompt_goal,
      extraDataCollection: normalizeDataCollection(agent.extra_data_collection),
      extraEvaluation: normalizeEvaluation(agent.extra_evaluation),
      toolsEnabled: (agent.tools_enabled ?? undefined) as
        | ToolsEnabled
        | undefined,
    },
    agent.elevenlabs_agent_id,
  );
  if (sync.error) return { error: sync.error };
  const { error } = await admin
    .from("agents")
    .update({
      system_prompt: newPrompt,
      ...(sync.elevenlabsAgentId &&
      sync.elevenlabsAgentId !== agent.elevenlabs_agent_id
        ? { elevenlabs_agent_id: sync.elevenlabsAgentId }
        : {}),
    })
    .eq("id", agent.id);
  return {
    error: error
      ? "Applied to ElevenLabs, but saving the local copy failed — open the agent editor and save it once to re-sync."
      : null,
  };
}

/** The available example pool for one (bucket, agent): human-approved
 *  ("Looks right" → status confirmed + curated_at) and not yet consumed by a
 *  suggestion. Newest first, capped at MAX_SUGGESTION_EXAMPLES. Flags don't
 *  carry agent_id, so pages of flags are joined to calls in chunks. */
export async function loadApprovedFlags(
  db: Admin,
  flagKey: string,
  agentId: string,
): Promise<{ id: string; call_id: string; evidence_quote: string | null }[]> {
  const out: { id: string; call_id: string; evidence_quote: string | null }[] =
    [];
  const PAGE = 500;
  for (let from = 0; out.length < MAX_SUGGESTION_EXAMPLES; from += PAGE) {
    const { data, error } = await db
      .from("call_review_flags")
      .select("id, call_id, evidence_quote")
      .eq("flag_key", flagKey)
      .eq("status", "confirmed")
      .not("curated_at", "is", null)
      .is("suggestion_id", null)
      .order("created_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error || !data || data.length === 0) break;
    const agentByCall = new Map<string, string | null>();
    for (const ids of chunk([...new Set(data.map((f) => f.call_id))])) {
      const { data: calls } = await db
        .from("calls")
        .select("id, agent_id")
        .in("id", ids);
      for (const c of calls ?? []) agentByCall.set(c.id, c.agent_id);
    }
    for (const f of data) {
      if (agentByCall.get(f.call_id) !== agentId) continue;
      out.push(f);
      if (out.length >= MAX_SUGGESTION_EXAMPLES) break;
    }
    if (data.length < PAGE) break;
  }
  return out;
}
```

- [ ] **Step 3: Typecheck + run unit tests**

Run: `npx tsc --noEmit` and `npm run test:unit`
Expected: both clean (the unit test file imports `suggest.ts`, which now imports the ElevenLabs module — module-scope code there is constants only, so vitest stays happy, matching the existing `analyze.ts` → `openai.ts` precedent).

- [ ] **Step 4: Commit**

```bash
git add src/lib/review/suggest.ts
git commit -m "feat(review): prompt resolve/write helpers + approved-example pool"
```

---

## Task 7: Record human curation on Looks right / False alarm

**Files:**

- Modify: `src/lib/review/actions.ts:193-206` (`setFlagStatus`)

- [ ] **Step 1: Stamp curated_by/curated_at**

Replace the existing `setFlagStatus` body:

```ts
/** Confirm or reject a single AI flag. Admin-only. Rejecting drops it out of its
 *  bucket (buckets only count confirmed + needs_review). Also stamps WHO decided
 *  and WHEN — the AI writes status='confirmed' on its own, so curated_at is what
 *  marks a HUMAN decision (only human-approved flags may feed prompt
 *  suggestions). */
export async function setFlagStatus(input: {
  flagId: string;
  status: "confirmed" | "rejected";
}): Promise<{ error: string | null }> {
  const adminId = await currentAdminId();
  if (!adminId) return { error: "Admins only." };
  const { error } = await adminClient()
    .from("call_review_flags")
    .update({
      status: input.status,
      curated_by: adminId,
      curated_at: new Date().toISOString(),
    })
    .eq("id", input.flagId);
  if (error) return { error: "Could not update the flag." };
  revalidatePath("/calls");
  revalidatePath("/reporting");
  return { error: null };
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `npx tsc --noEmit` — expected clean.

```bash
git add src/lib/review/actions.ts
git commit -m "feat(review): stamp human curation on Looks right / False alarm"
```

---

## Task 8: Server actions — generate / apply / dismiss / revert

**Files:**

- Modify: `src/lib/review/actions.ts` (append; also extend its imports)

All four are admin-only and follow the file's existing conventions (friendly error strings, `revalidatePath`). Ordering rule: ElevenLabs succeeds BEFORE any DB bookkeeping.

- [ ] **Step 1: Extend the imports at the top of `actions.ts`**

```ts
import type { Database, Json } from "@/lib/supabase/database.types";
```

(replaces the existing `import type { Database } ...` line)

```ts
import type { PromptEdit } from "./types";
import { PASS2_MODEL } from "./openai";
import {
  AGENT_PROMPT_COLUMNS,
  applyPromptEdits,
  draftPromptSuggestion,
  loadApprovedFlags,
  resolveCurrentAgentPrompt,
  writeAgentPrompt,
  type AgentPromptRow,
} from "./suggest";
```

- [ ] **Step 2: Append the four actions**

```ts
/** Draft a prompt-improvement suggestion for one (bucket, agent) from the
 *  human-approved examples. On success the contributing flags are stamped with
 *  the suggestion id so the same example never feeds two suggestions. */
export async function generatePromptSuggestion(input: {
  flagKey: string;
  agentId: string;
}): Promise<{ error: string | null }> {
  const adminId = await currentAdminId();
  if (!adminId) return { error: "Admins only." };
  const key = input.flagKey.trim();
  if (!key || !input.agentId) return { error: "Missing bucket or agent." };
  const db = adminClient();

  const { data: def } = await db
    .from("review_flag_defs")
    .select("key, label, guidance")
    .eq("key", key)
    .eq("is_candidate", false)
    .maybeSingle();
  if (!def) return { error: "That flag no longer exists." };

  const { data: agent } = await db
    .from("agents")
    .select(AGENT_PROMPT_COLUMNS)
    .eq("id", input.agentId)
    .maybeSingle();
  if (!agent) return { error: "That agent no longer exists." };

  const cur = await resolveCurrentAgentPrompt(agent as AgentPromptRow);
  if (!cur.prompt) return { error: cur.error };

  const flags = await loadApprovedFlags(db, key, input.agentId);
  if (flags.length === 0) {
    return {
      error:
        "No approved examples are available for this bucket and agent — confirm findings with “Looks right” first.",
    };
  }

  const drafted = await draftPromptSuggestion({
    prompt: cur.prompt,
    bucket: def,
    examples: flags.map((f) => ({ evidenceQuote: f.evidence_quote })),
  });
  if (!drafted.draft) return { error: drafted.error };

  const { data: created, error: insErr } = await db
    .from("review_prompt_suggestions")
    .insert({
      agent_id: input.agentId,
      flag_key: key,
      based_on_prompt: cur.prompt,
      proposed_prompt: drafted.draft.proposedPrompt,
      edits: drafted.draft.edits as unknown as Json,
      rationale: drafted.draft.rationale,
      summary: drafted.draft.summary,
      example_count: flags.length,
      model: PASS2_MODEL,
      cost: drafted.cost,
    })
    .select("id")
    .single();
  if (insErr || !created) return { error: "Could not save the suggestion." };

  await db
    .from("call_review_flags")
    .update({ suggestion_id: created.id })
    .in(
      "id",
      flags.map((f) => f.id),
    );
  revalidatePath("/reporting");
  return { error: null };
}

/** Apply an approved suggestion to the live agent. Marija may have reworded the
 *  new text (editedTexts, aligned with the stored edits) — anchors are fixed.
 *  Refuses when the live prompt no longer matches what the suggestion was
 *  drafted against. ElevenLabs first; log + statuses only after success. */
export async function applyPromptSuggestion(input: {
  suggestionId: string;
  editedTexts?: string[];
}): Promise<{ error: string | null }> {
  const adminId = await currentAdminId();
  if (!adminId) return { error: "Admins only." };
  const db = adminClient();

  const { data: s } = await db
    .from("review_prompt_suggestions")
    .select("*")
    .eq("id", input.suggestionId)
    .maybeSingle();
  if (!s) return { error: "That suggestion no longer exists." };
  if (s.status !== "proposed") {
    return { error: "This suggestion was already decided." };
  }

  let edits = s.edits as unknown as PromptEdit[];
  if (input.editedTexts) {
    if (input.editedTexts.length !== edits.length) {
      return { error: "Edited texts don't match the suggestion." };
    }
    edits = edits.map((e, i) => ({ ...e, text: input.editedTexts![i] }));
  }
  const applied = applyPromptEdits(s.based_on_prompt, edits);
  if (!applied.result) return { error: applied.error };
  const finalPrompt = applied.result.trim();

  const { data: agent } = await db
    .from("agents")
    .select(AGENT_PROMPT_COLUMNS)
    .eq("id", s.agent_id)
    .maybeSingle();
  if (!agent) return { error: "That agent no longer exists." };

  const cur = await resolveCurrentAgentPrompt(agent as AgentPromptRow);
  if (!cur.prompt) return { error: cur.error };
  if (cur.prompt !== s.based_on_prompt) {
    return {
      error:
        "The agent's prompt changed since this suggestion was drafted. Dismiss it and generate a fresh one.",
    };
  }

  const w = await writeAgentPrompt(db, agent as AgentPromptRow, finalPrompt);
  if (w.error) return { error: w.error };

  const { data: def } = await db
    .from("review_flag_defs")
    .select("label")
    .eq("key", s.flag_key)
    .maybeSingle();
  await db.from("agent_prompt_log").insert({
    agent_id: s.agent_id,
    changed: "Changed",
    what_changed: s.summary,
    why: `${s.rationale} — based on ${s.example_count} approved example(s) in "${def?.label ?? s.flag_key}".`,
    full_prompt: finalPrompt,
  });
  await db
    .from("review_prompt_suggestions")
    .update({
      status: "applied",
      edits: edits as unknown as Json,
      proposed_prompt: finalPrompt,
      decided_by: adminId,
      decided_at: new Date().toISOString(),
      applied_at: new Date().toISOString(),
    })
    .eq("id", s.id);
  revalidatePath("/reporting");
  return { error: null };
}

/** Dismiss a proposed suggestion. Its examples return to the available pool. */
export async function dismissPromptSuggestion(input: {
  suggestionId: string;
}): Promise<{ error: string | null }> {
  const adminId = await currentAdminId();
  if (!adminId) return { error: "Admins only." };
  const db = adminClient();
  const { data, error } = await db
    .from("review_prompt_suggestions")
    .update({
      status: "dismissed",
      decided_by: adminId,
      decided_at: new Date().toISOString(),
    })
    .eq("id", input.suggestionId)
    .eq("status", "proposed")
    .select("id");
  if (error || !data || data.length === 0) {
    return { error: "Could not dismiss the suggestion." };
  }
  await db
    .from("call_review_flags")
    .update({ suggestion_id: null })
    .eq("suggestion_id", input.suggestionId);
  revalidatePath("/reporting");
  return { error: null };
}

/** Restore the pre-suggestion prompt. Only valid while the live prompt still
 *  equals what this suggestion produced (nothing else changed it since) — the
 *  same never-overwrite-unseen-state rule as apply. Its examples return to the
 *  available pool. */
export async function revertPromptSuggestion(input: {
  suggestionId: string;
}): Promise<{ error: string | null }> {
  const adminId = await currentAdminId();
  if (!adminId) return { error: "Admins only." };
  const db = adminClient();

  const { data: s } = await db
    .from("review_prompt_suggestions")
    .select("*")
    .eq("id", input.suggestionId)
    .maybeSingle();
  if (!s) return { error: "That suggestion no longer exists." };
  if (s.status !== "applied")
    return { error: "Only applied changes can be reverted." };

  const { data: agent } = await db
    .from("agents")
    .select(AGENT_PROMPT_COLUMNS)
    .eq("id", s.agent_id)
    .maybeSingle();
  if (!agent) return { error: "That agent no longer exists." };

  const cur = await resolveCurrentAgentPrompt(agent as AgentPromptRow);
  if (!cur.prompt) return { error: cur.error };
  if (cur.prompt !== s.proposed_prompt) {
    return {
      error:
        "The prompt has changed again since this was applied — revert it manually in the agent editor instead.",
    };
  }

  const w = await writeAgentPrompt(
    db,
    agent as AgentPromptRow,
    s.based_on_prompt,
  );
  if (w.error) return { error: w.error };

  await db.from("agent_prompt_log").insert({
    agent_id: s.agent_id,
    changed: "Changed",
    what_changed: `Reverted: ${s.summary}`,
    why: "Manual revert from Reporting → Prompt improvements.",
    full_prompt: s.based_on_prompt,
  });
  await db
    .from("review_prompt_suggestions")
    .update({ status: "reverted", reverted_at: new Date().toISOString() })
    .eq("id", s.id);
  await db
    .from("call_review_flags")
    .update({ suggestion_id: null })
    .eq("suggestion_id", s.id);
  revalidatePath("/reporting");
  return { error: null };
}
```

- [ ] **Step 3: Typecheck + lint + commit**

Run: `npx tsc --noEmit` and `npx eslint src/lib/review/actions.ts`
Expected: both clean.

```bash
git add src/lib/review/actions.ts
git commit -m "feat(review): generate/apply/dismiss/revert prompt suggestions"
```

---

## Task 9: Read-side loaders for the Reporting tab

**Files:**

- Create: `src/lib/review/suggestions-data.ts`

Two RSC loaders using the page's admin-gated RLS client (matching `buckets.ts`): per-bucket suggest options (which agents have available approved examples) and the suggestions list for the panel. Both avoid PostgREST joins (the hand-maintained types have no Relationships) and respect the 1000-row cap by paginating/chunking.

- [ ] **Step 1: Create the file**

```ts
import "server-only";

import type { createClient as createServerClient } from "@/lib/supabase/server";

import { chunk } from "./chunk";
import type { PromptEdit } from "./types";

type ServerClient = Awaited<ReturnType<typeof createServerClient>>;

export type SuggestOption = {
  agentId: string;
  agentName: string;
  available: number;
};

/** flag_key -> agents with available (human-approved, unconsumed) examples. */
export type SuggestOptionsByBucket = Record<string, SuggestOption[]>;

/** Powers the per-bucket "Suggest prompt fix" button. Pages call_review_flags
 *  (PostgREST 1000-row cap), resolves call→agent in chunks, tallies in JS —
 *  same pattern as fetchChecklistFlags. */
export async function fetchSuggestOptions(
  client: ServerClient,
): Promise<SuggestOptionsByBucket> {
  const flags: { flag_key: string; call_id: string }[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client
      .from("call_review_flags")
      .select("flag_key, call_id")
      .eq("status", "confirmed")
      .not("curated_at", "is", null)
      .is("suggestion_id", null)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) break;
    const page = data ?? [];
    for (const r of page) {
      if (r.call_id) flags.push({ flag_key: r.flag_key, call_id: r.call_id });
    }
    if (page.length < PAGE) break;
  }
  if (flags.length === 0) return {};

  const agentByCall = new Map<string, string>();
  for (const ids of chunk([...new Set(flags.map((f) => f.call_id))])) {
    const { data } = await client
      .from("calls")
      .select("id, agent_id")
      .in("id", ids);
    for (const c of data ?? [])
      if (c.agent_id) agentByCall.set(c.id, c.agent_id);
  }

  const counts = new Map<string, Map<string, number>>();
  for (const f of flags) {
    const agentId = agentByCall.get(f.call_id);
    if (!agentId) continue;
    const perAgent = counts.get(f.flag_key) ?? new Map<string, number>();
    perAgent.set(agentId, (perAgent.get(agentId) ?? 0) + 1);
    counts.set(f.flag_key, perAgent);
  }

  const agentIds = [
    ...new Set([...counts.values()].flatMap((m) => [...m.keys()])),
  ];
  const nameById = new Map<string, string>();
  if (agentIds.length > 0) {
    const { data } = await client
      .from("agents")
      .select("id, name")
      .in("id", agentIds);
    for (const a of data ?? []) nameById.set(a.id, a.name);
  }

  const out: SuggestOptionsByBucket = {};
  for (const [key, perAgent] of counts) {
    out[key] = [...perAgent.entries()]
      .map(([agentId, available]) => ({
        agentId,
        agentName: nameById.get(agentId) ?? "Unknown agent",
        available,
      }))
      .sort((a, b) => b.available - a.available);
  }
  return out;
}

export type PromptSuggestionView = {
  id: string;
  agentName: string;
  bucketLabel: string;
  status: "proposed" | "applied" | "dismissed" | "reverted";
  rationale: string;
  summary: string;
  edits: PromptEdit[];
  exampleCount: number;
  /** Contributing calls (present while the suggestion holds its examples). */
  callIds: string[];
  createdAt: string;
  appliedAt: string | null;
};

const SUGGESTION_LIST_CAP = 30;

/** The "Prompt improvements" panel list: awaiting-review first, then the most
 *  recently decided. Names/labels/contributing calls joined in JS. */
export async function fetchPromptSuggestions(
  client: ServerClient,
): Promise<PromptSuggestionView[]> {
  const { data: rows } = await client
    .from("review_prompt_suggestions")
    .select(
      "id, agent_id, flag_key, status, rationale, summary, edits, example_count, created_at, applied_at",
    )
    .order("created_at", { ascending: false })
    .limit(SUGGESTION_LIST_CAP);
  const list = rows ?? [];
  if (list.length === 0) return [];

  const agentIds = [...new Set(list.map((r) => r.agent_id))];
  const keys = [...new Set(list.map((r) => r.flag_key))];
  const [{ data: agents }, { data: defs }, { data: flagRows }] =
    await Promise.all([
      client.from("agents").select("id, name").in("id", agentIds),
      client.from("review_flag_defs").select("key, label").in("key", keys),
      client
        .from("call_review_flags")
        .select("call_id, suggestion_id")
        .in(
          "suggestion_id",
          list.map((r) => r.id),
        ),
    ]);
  const nameById = new Map((agents ?? []).map((a) => [a.id, a.name]));
  const labelByKey = new Map((defs ?? []).map((d) => [d.key, d.label]));
  const callsBySuggestion = new Map<string, string[]>();
  for (const f of flagRows ?? []) {
    if (!f.suggestion_id || !f.call_id) continue;
    const arr = callsBySuggestion.get(f.suggestion_id) ?? [];
    arr.push(f.call_id);
    callsBySuggestion.set(f.suggestion_id, arr);
  }

  const shaped: PromptSuggestionView[] = list.map((r) => ({
    id: r.id,
    agentName: nameById.get(r.agent_id) ?? "Unknown agent",
    bucketLabel: labelByKey.get(r.flag_key) ?? r.flag_key,
    status: r.status as PromptSuggestionView["status"],
    rationale: r.rationale,
    summary: r.summary,
    edits: r.edits as unknown as PromptEdit[],
    exampleCount: r.example_count,
    callIds: callsBySuggestion.get(r.id) ?? [],
    createdAt: r.created_at,
    appliedAt: r.applied_at,
  }));
  return [
    ...shaped.filter((s) => s.status === "proposed"),
    ...shaped.filter((s) => s.status !== "proposed"),
  ];
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `npx tsc --noEmit` — expected clean.

```bash
git add src/lib/review/suggestions-data.ts
git commit -m "feat(review): loaders for suggest options + prompt suggestions list"
```

---

## Task 10: Bucket button + agent-picker dialog

**Files:**

- Create: `src/app/(app)/reporting/suggest-fix-dialog.tsx`
- Modify: `src/app/(app)/reporting/call-review-table.tsx`
- Modify: `src/app/(app)/reporting/page.tsx` (CallReviewTab)

- [ ] **Step 1: Create the dialog component**

`src/app/(app)/reporting/suggest-fix-dialog.tsx`:

```tsx
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { generatePromptSuggestion } from "@/lib/review/actions";
import type { SuggestOption } from "@/lib/review/suggestions-data";

/** Per-bucket "Suggest prompt fix": pick the agent (preselected when only one
 *  has approved examples) and draft ONE anchored edit from those examples.
 *  Nothing touches the agent here — the draft lands in "Prompt improvements"
 *  for review. */
export function SuggestFixDialog({
  bucketKey,
  bucketLabel,
  options,
}: {
  bucketKey: string;
  bucketLabel: string;
  options: SuggestOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [agentId, setAgentId] = useState(options[0]?.agentId ?? "");
  const [pending, start] = useTransition();
  const total = options.reduce((n, o) => n + o.available, 0);
  if (total === 0) return null;

  function generate() {
    start(async () => {
      const r = await generatePromptSuggestion({ flagKey: bucketKey, agentId });
      if (r.error) {
        toast.error(r.error);
        return;
      }
      toast.success(
        "Suggestion drafted — review it under Prompt improvements.",
      );
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8"
          title={`Draft a prompt fix from ${total} approved example${total === 1 ? "" : "s"}`}
        >
          <Sparkles className="size-3.5" />
          Suggest prompt fix ({total})
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Draft a prompt fix</DialogTitle>
        </DialogHeader>
        <p className="text-muted-foreground text-sm">
          The AI reads the agent&apos;s live prompt plus your approved &ldquo;
          {bucketLabel}&rdquo; examples and drafts one targeted edit. Nothing
          changes until you approve it.
        </p>
        <div className="flex flex-col gap-2">
          {options.map((o) => (
            <label
              key={o.agentId}
              className="border-border hover:bg-muted/40 flex cursor-pointer items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm"
            >
              <span className="flex items-center gap-2">
                <input
                  type="radio"
                  name={`suggest-agent-${bucketKey}`}
                  checked={agentId === o.agentId}
                  onChange={() => setAgentId(o.agentId)}
                />
                {o.agentName}
              </span>
              <span className="text-muted-foreground text-xs">
                {o.available} example{o.available === 1 ? "" : "s"}
              </span>
            </label>
          ))}
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button onClick={generate} disabled={pending || !agentId}>
            {pending ? "Drafting…" : "Generate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Thread suggest options through `call-review-table.tsx`**

Add the imports:

```tsx
import type { SuggestOptionsByBucket } from "@/lib/review/suggestions-data";
import { SuggestFixDialog } from "./suggest-fix-dialog";
```

Change the `CallReviewTable` signature (new optional-free prop) and pass options down:

```tsx
export function CallReviewTable({
  summary,
  buckets,
  suggestOptions,
}: {
  summary: ReviewSummary;
  buckets: ReviewBucket[];
  suggestOptions: SuggestOptionsByBucket;
}) {
```

In the lens loop, pass each bucket its options:

```tsx
{
  byLens
    .get(lens)!
    .map((b, i) => (
      <BucketRow
        key={b.key}
        bucket={b}
        topBorder={i > 0}
        suggestOptions={suggestOptions[b.key] ?? []}
      />
    ));
}
```

Change `BucketRow`'s signature and render the dialog just before the "Mark all reviewed" button (inside the right-hand `div.flex.shrink-0`):

```tsx
function BucketRow({
  bucket,
  topBorder,
  suggestOptions,
}: {
  bucket: ReviewBucket;
  topBorder: boolean;
  suggestOptions: SuggestOption[];
}) {
```

(add `import type { SuggestOption } from "@/lib/review/suggestions-data";` — or widen the first type import to `import type { SuggestOption, SuggestOptionsByBucket } ...`)

```tsx
      <div className="flex shrink-0 items-center gap-2">
        {suggestOptions.length > 0 ? (
          <SuggestFixDialog
            bucketKey={bucket.key}
            bucketLabel={bucket.label}
            options={suggestOptions}
          />
        ) : null}
        {bucket.unreviewed > 0 ? (
```

- [ ] **Step 3: Wire the loader in `page.tsx`**

In `CallReviewTab`, extend the parallel fetch and the prop:

```tsx
import { fetchSuggestOptions } from "@/lib/review/suggestions-data";
```

```tsx
async function CallReviewTab() {
  const supabase = await createClient();
  const [{ summary, buckets }, candidates, checklist, suggestOptions] =
    await Promise.all([
      fetchReviewBuckets(supabase),
      fetchCandidateFlags(supabase),
      fetchChecklistFlags(supabase),
      fetchSuggestOptions(supabase),
    ]);
  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h2 className="text-foreground text-base font-semibold">
          Review flagged calls
        </h2>
        <CallReviewTable
          summary={summary}
          buckets={buckets}
          suggestOptions={suggestOptions}
        />
      </section>
      <section className="flex flex-col gap-3">
        <AiChecklistPanel flags={checklist} candidates={candidates} />
      </section>
    </div>
  );
}
```

- [ ] **Step 4: Typecheck + commit**

Run: `npx tsc --noEmit` and `npx eslint src/app/(app)/reporting`
Expected: clean.

```bash
git add src/app/(app)/reporting/suggest-fix-dialog.tsx src/app/(app)/reporting/call-review-table.tsx "src/app/(app)/reporting/page.tsx"
git commit -m "feat(review): per-bucket Suggest prompt fix button + agent picker"
```

---

## Task 11: The "Prompt improvements" panel

**Files:**

- Create: `src/app/(app)/reporting/prompt-suggestions-panel.tsx`
- Modify: `src/app/(app)/reporting/page.tsx` (CallReviewTab — third section)

- [ ] **Step 1: Create the panel**

`src/app/(app)/reporting/prompt-suggestions-panel.tsx`:

```tsx
"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Undo2, Wand2, X } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  applyPromptSuggestion,
  dismissPromptSuggestion,
  revertPromptSuggestion,
} from "@/lib/review/actions";
import type { PromptSuggestionView } from "@/lib/review/suggestions-data";

const STATUS_LABEL: Record<PromptSuggestionView["status"], string> = {
  proposed: "Awaiting your review",
  applied: "Applied",
  dismissed: "Dismissed",
  reverted: "Reverted",
};

/** "Prompt improvements": AI-drafted anchored edits built from findings Marija
 *  approved. Shows the exact old→new diff (new text editable), applies only on
 *  explicit approval, and keeps a revert path on applied changes. */
export function PromptSuggestionsPanel({
  suggestions,
}: {
  suggestions: PromptSuggestionView[];
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Wand2 className="text-muted-foreground size-5" />
        <h2 className="text-foreground text-base font-semibold">
          Prompt improvements
        </h2>
      </div>
      <p className="text-muted-foreground -mt-2 text-xs">
        AI-drafted prompt fixes built only from findings you approved. Review
        the exact change (reword it if you like) — nothing reaches the agent
        until you approve it, and every applied change can be reverted.
      </p>
      {suggestions.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No suggestions yet. Confirm findings with &ldquo;Looks right&rdquo; in
          a call&apos;s review panel, then use &ldquo;Suggest prompt fix&rdquo;
          on a bucket above.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {suggestions.map((s) => (
            <SuggestionCard key={s.id} suggestion={s} />
          ))}
        </div>
      )}
    </div>
  );
}

function SuggestionCard({
  suggestion: s,
}: {
  suggestion: PromptSuggestionView;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [texts, setTexts] = useState(() => s.edits.map((e) => e.text));
  const proposed = s.status === "proposed";

  function run(action: () => Promise<{ error: string | null }>, done: string) {
    start(async () => {
      const r = await action();
      if (r.error) {
        toast.error(r.error);
        return;
      }
      toast.success(done);
      router.refresh();
    });
  }

  return (
    <div className="border-border bg-card flex flex-col gap-3 rounded-xl border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-foreground text-sm font-semibold">
          {s.bucketLabel}
        </span>
        <span className="text-muted-foreground text-xs">· {s.agentName}</span>
        <span className="text-muted-foreground text-xs">
          · {new Date(s.createdAt).toLocaleDateString()}
        </span>
        <Badge
          variant={proposed ? "default" : "secondary"}
          className={proposed ? "" : "opacity-80"}
        >
          {STATUS_LABEL[s.status]}
        </Badge>
      </div>

      <p className="text-foreground text-sm">{s.rationale}</p>

      <div className="flex flex-col gap-3">
        {s.edits.map((e, i) => (
          <div key={i} className="flex flex-col gap-1.5">
            {e.type === "replace" ? (
              <>
                <p className="text-muted-foreground text-xs font-medium">
                  Replace this part:
                </p>
                <pre className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs whitespace-pre-wrap text-red-900">
                  {e.anchor}
                </pre>
                <p className="text-muted-foreground text-xs font-medium">
                  With:
                </p>
              </>
            ) : e.type === "insert_after" ? (
              <>
                <p className="text-muted-foreground text-xs font-medium">
                  Right after this part:
                </p>
                <pre className="border-border bg-muted/30 text-muted-foreground rounded-lg border px-3 py-2 text-xs whitespace-pre-wrap">
                  {e.anchor}
                </pre>
                <p className="text-muted-foreground text-xs font-medium">
                  Add:
                </p>
              </>
            ) : (
              <p className="text-muted-foreground text-xs font-medium">
                Add at the very end of the prompt:
              </p>
            )}
            {proposed ? (
              <Textarea
                rows={3}
                value={texts[i]}
                onChange={(ev) =>
                  setTexts(texts.map((t, j) => (j === i ? ev.target.value : t)))
                }
                className="border-emerald-200 bg-emerald-50/60 text-sm"
              />
            ) : (
              <pre className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs whitespace-pre-wrap text-emerald-900">
                {e.text}
              </pre>
            )}
          </div>
        ))}
      </div>

      <p className="text-muted-foreground text-xs">
        Based on {s.exampleCount} approved example
        {s.exampleCount === 1 ? "" : "s"}
        {s.callIds.length > 0 ? (
          <>
            {": "}
            {s.callIds.map((id, i) => (
              <span key={id}>
                {i > 0 ? ", " : ""}
                <Link
                  href={`/calls?call=${id}`}
                  className="hover:text-primary underline underline-offset-2"
                >
                  call {i + 1}
                </Link>
              </span>
            ))}
          </>
        ) : null}
        .
      </p>

      {proposed ? (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            disabled={pending}
            onClick={() =>
              run(
                () =>
                  applyPromptSuggestion({
                    suggestionId: s.id,
                    editedTexts: texts,
                  }),
                "Applied to the agent.",
              )
            }
          >
            <Check className="size-3.5" />
            {pending ? "Working…" : "Approve & apply"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() =>
              run(
                () => dismissPromptSuggestion({ suggestionId: s.id }),
                "Dismissed — those examples are available again.",
              )
            }
          >
            <X className="size-3.5" />
            Dismiss
          </Button>
        </div>
      ) : s.status === "applied" ? (
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-xs">
            Applied{" "}
            {s.appliedAt ? new Date(s.appliedAt).toLocaleDateString() : ""} —
            logged in the Agent Prompt Log.
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() =>
              run(
                () => revertPromptSuggestion({ suggestionId: s.id }),
                "Previous prompt restored.",
              )
            }
          >
            <Undo2 className="size-3.5" />
            {pending ? "Working…" : "Revert"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 2: Add the third section in `page.tsx`**

Extend the import and `CallReviewTab`:

```tsx
import {
  fetchPromptSuggestions,
  fetchSuggestOptions,
} from "@/lib/review/suggestions-data";
import { PromptSuggestionsPanel } from "./prompt-suggestions-panel";
```

```tsx
async function CallReviewTab() {
  const supabase = await createClient();
  const [
    { summary, buckets },
    candidates,
    checklist,
    suggestOptions,
    suggestions,
  ] = await Promise.all([
    fetchReviewBuckets(supabase),
    fetchCandidateFlags(supabase),
    fetchChecklistFlags(supabase),
    fetchSuggestOptions(supabase),
    fetchPromptSuggestions(supabase),
  ]);
  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h2 className="text-foreground text-base font-semibold">
          Review flagged calls
        </h2>
        <CallReviewTable
          summary={summary}
          buckets={buckets}
          suggestOptions={suggestOptions}
        />
      </section>
      <section className="flex flex-col gap-3">
        <AiChecklistPanel flags={checklist} candidates={candidates} />
      </section>
      <section className="flex flex-col gap-3">
        <PromptSuggestionsPanel suggestions={suggestions} />
      </section>
    </div>
  );
}
```

(Per the spec: "Prompt improvements" is the THIRD section, after "Review flagged calls" and "The AI's checklist".)

- [ ] **Step 3: Build + commit**

Run: `npx tsc --noEmit`, `npx eslint src/app/(app)/reporting`, `npm run build`
Expected: all clean.

```bash
git add src/app/(app)/reporting/prompt-suggestions-panel.tsx "src/app/(app)/reporting/page.tsx"
git commit -m "feat(review): Prompt improvements panel (diff review, apply, revert)"
```

---

## Task 12: Playwright contract spec

**Files:**

- Create: `tests/prompt-suggestions.spec.ts`

Contract-level UI coverage (specs run against the live environment — no CI). Deliberately avoids the two paid/live paths: no Generate click (would call OpenAI for real) and no Approve click (would PATCH ElevenLabs). Those paths' logic is unit-tested (Task 3/4) and their wiring is thin. Covered here: button visibility with an available approved example, the suggestion card rendering (diff + rationale + editable text), and Dismiss (pure DB → safe live).

- [ ] **Step 1: Write the spec**

```ts
import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { signIn } from "./helpers";

test.describe.configure({ mode: "serial" });

/**
 * Prompt improvement suggestions (Reporting → Call review):
 *  - A bucket with a human-approved (curated) example shows "Suggest prompt
 *    fix (1)".
 *  - A seeded proposed suggestion renders in "Prompt improvements" with its
 *    rationale, an editable new-text box, and Approve/Dismiss.
 *  - Dismiss marks the suggestion dismissed (DB-checked) and clears it from
 *    "awaiting review".
 *  Generate/Approve are NOT exercised e2e (real OpenAI/ElevenLabs cost) — the
 *  edit engine and drafting are unit-tested in tests/prompt-suggest.unit.test.ts.
 */
test.describe("Prompt suggestions", () => {
  const stamp = Date.now();
  const FLAG_KEY = `e2e_sugg_${stamp}`;
  const FLAG_LABEL = `E2E Suggest ${stamp}`;
  const AGENT_PROMPT = `You are the E2E suggestion agent ${stamp}.\nAlways be brief.`;
  let admin: SupabaseClient;
  let ownerId: string;
  let agentId: string;
  let listId: string;
  let leadId: string;
  let callId: string;
  let suggestionId: string;

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

    const { data: agent } = await admin
      .from("agents")
      .insert({
        owner_id: ownerId,
        name: `E2E Suggest Agent ${stamp}`,
        system_prompt: AGENT_PROMPT,
        prompt_personality: "x",
        prompt_environment: "x",
        prompt_tone: "x",
        prompt_goal: "x",
        prompt_guardrails: "x",
      })
      .select("id")
      .single();
    agentId = agent!.id as string;

    const { data: list } = await admin
      .from("lists")
      .insert({ owner_id: ownerId, name: `E2E Suggest List ${stamp}` })
      .select("id")
      .single();
    listId = list!.id as string;

    const { data: lead } = await admin
      .from("leads")
      .insert({
        owner_id: ownerId,
        company: `E2E Suggest Co ${stamp}`,
        business_phone: `+1556${String(stamp).slice(-7)}`,
        status: "ready_to_call",
        list_id: listId,
      })
      .select("id")
      .single();
    leadId = lead!.id as string;

    const { data: call } = await admin
      .from("calls")
      .insert({
        lead_id: leadId,
        agent_id: agentId,
        direction: "outbound",
        status: "completed",
        outcome: "completed",
        duration_seconds: 60,
        started_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    callId = call!.id as string;

    // An active rubric def + a review row + a HUMAN-approved flag on the call.
    await admin.from("review_flag_defs").insert({
      key: FLAG_KEY,
      label: FLAG_LABEL,
      lens: "quality",
      severity: 2,
      guidance: "E2E: the agent made the seeded mistake.",
      active: true,
      is_candidate: false,
    });
    await admin.from("call_reviews").insert({
      call_id: callId,
      status: "done",
      reached_human: true,
    });
    await admin.from("call_review_flags").insert({
      call_id: callId,
      flag_key: FLAG_KEY,
      evidence_quote: "e2e example quote",
      confidence: 0.9,
      status: "confirmed",
      curated_by: ownerId,
      curated_at: new Date().toISOString(),
    });

    // A seeded proposed suggestion (as if Generate had run).
    const { data: sugg } = await admin
      .from("review_prompt_suggestions")
      .insert({
        agent_id: agentId,
        flag_key: FLAG_KEY,
        based_on_prompt: AGENT_PROMPT,
        proposed_prompt: `${AGENT_PROMPT}\n\nE2E RULE ${stamp}: never repeat the mistake.`,
        edits: [
          {
            type: "append",
            anchor: "",
            text: `E2E RULE ${stamp}: never repeat the mistake.`,
          },
        ],
        rationale: `E2E rationale ${stamp}: the examples show a recurring mistake.`,
        summary: `E2E summary ${stamp}`,
        example_count: 1,
      })
      .select("id")
      .single();
    suggestionId = sugg!.id as string;
  });

  test.afterAll(async () => {
    await admin.from("call_review_flags").delete().eq("flag_key", FLAG_KEY);
    await admin
      .from("review_prompt_suggestions")
      .delete()
      .eq("flag_key", FLAG_KEY);
    await admin.from("call_reviews").delete().eq("call_id", callId);
    await admin.from("calls").delete().eq("id", callId);
    await admin.from("review_flag_defs").delete().eq("key", FLAG_KEY);
    await admin.from("leads").delete().eq("id", leadId);
    await admin.from("lists").delete().eq("id", listId);
    await admin.from("agents").delete().eq("id", agentId);
  });

  test("bucket with an approved example offers Suggest prompt fix", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto("/reporting?tab=call-review");
    // The seeded bucket (unique label) is on the page, and its row carries the
    // suggest button with the available-example count.
    await expect(page.getByText(FLAG_LABEL).first()).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Suggest prompt fix (1)" }).first(),
    ).toBeVisible();
  });

  test("a proposed suggestion renders diff, rationale, and editable text", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto("/reporting?tab=call-review");
    await expect(
      page.getByText(`E2E rationale ${stamp}`, { exact: false }),
    ).toBeVisible();
    await expect(page.getByText("Awaiting your review").first()).toBeVisible();
    // The new text is editable before approval, prefilled from the edit.
    await expect(page.locator("textarea").first()).toHaveValue(
      new RegExp(`E2E RULE ${stamp}`),
    );
    await expect(
      page.getByRole("button", { name: "Approve & apply" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Dismiss" })).toBeVisible();
  });

  test("dismiss archives the suggestion", async ({ page }) => {
    await signIn(page);
    await page.goto("/reporting?tab=call-review");
    await page.getByRole("button", { name: "Dismiss" }).first().click();
    await expect(page.getByText("Dismissed —", { exact: false })).toBeVisible();
    // DB-level assertion: the row is dismissed.
    await expect
      .poll(async () => {
        const { data } = await admin
          .from("review_prompt_suggestions")
          .select("status")
          .eq("id", suggestionId)
          .single();
        return data?.status;
      })
      .toBe("dismissed");
  });
});
```

- [ ] **Step 2: Typecheck + lint the spec (it can't run locally)**

Run: `npx tsc --noEmit` and `npx eslint tests/prompt-suggestions.spec.ts`
Expected: clean. (Playwright specs run against the live environment after deploy, per project practice.)

- [ ] **Step 3: Commit**

```bash
git add tests/prompt-suggestions.spec.ts
git commit -m "test(review): prompt suggestions UI contract spec"
```

---

## Task 13: Verify, PR, ship

- [ ] **Step 0: Live ElevenLabs smoke test of the prompt-only PATCH (BEFORE any production use)**

`updateElevenLabsAgentPrompt` relies on one assumption with no codebase precedent: omitting `platform_settings` from the PATCH body leaves it untouched server-side. Verify empirically against a SCRATCH agent (never the real one), via a temporary script run with the prod env (`ELEVENLABS_LIVE=live`):

1. Create a scratch agent (`syncAgentToElevenLabs` with a dummy payload) — also cover a second shape with `tool_ids: []` (no server tools enabled).
2. GET and save its FULL config (both `conversation_config` and `platform_settings`).
3. Call `updateElevenLabsAgentPrompt` with a new prompt text.
4. GET again and diff: `conversation_config.agent.prompt.prompt` changed; EVERYTHING else — especially all of `platform_settings` (data_collection, evaluation, guardrails, workspace_overrides) — byte-identical.
5. Delete the scratch agent(s) (`deleteAgentOnElevenLabs`). Report the diff result before proceeding.

- [ ] **Step 1: Full local verification**

```bash
npx tsc --noEmit
npx eslint src/lib/review src/lib/elevenlabs/agents.ts "src/app/(app)/reporting" tests/prompt-suggestions.spec.ts tests/prompt-suggest.unit.test.ts
npm run test:unit
npm run build
```

Expected: all clean/passing. Fix anything that isn't before proceeding.

- [ ] **Step 2: Push the branch + open the PR**

```bash
git push -u origin feat/call-review-prompt-suggestions
gh pr create --title "feat(review): prompt improvement suggestions from approved findings" --body "$(cat <<'EOF'
## What
Closes the call-review loop: findings Marija explicitly approved ("Looks right") can now feed an on-demand, AI-drafted improvement to the agent's system prompt — reviewed as an exact old→new diff (with editable wording) and applied to the live ElevenLabs agent only on explicit approval.

- Migration (additive): `review_prompt_suggestions` + `curated_by/curated_at/suggestion_id` on `call_review_flags`
- Anchored-edit engine: the AI may only replace/insert-after/append against verbatim, unique anchors — validated mechanically, rejected otherwise (unit-tested)
- Drafting via existing `callOpenAiJson` (gpt-5.4), one auto-retry with validator feedback, cost stored per suggestion
- Apply: freshness check (live prompt must match what the draft was based on) → prompt-only ElevenLabs PATCH (read-modify-write) → auto Agent Prompt Log entry → reviewer playbook cache refresh; Revert with the same safety checks
- Reporting → Call review: per-bucket "Suggest prompt fix (N)" + new "Prompt improvements" section
- Spec: docs/superpowers/specs/2026-07-16-call-review-prompt-suggestions-design.md

## Safety
- Only human-curated findings feed suggestions (AI-confirmed alone doesn't count)
- ElevenLabs write first; DB bookkeeping only after success
- Anchors validated exactly-once; no full-prompt rewrites possible
- Everything admin-only; RLS matches existing review tables

## Testing
- `tests/prompt-suggest.unit.test.ts` (vitest) — edit engine + mock drafting
- `tests/prompt-suggestions.spec.ts` (Playwright contract) — button visibility, card render, dismiss
- tsc / eslint / build clean

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Apply the migration to prod (BEFORE merge — it's additive, old code ignores it)**

```bash
supabase db push --linked
```

Expected: applies `20260716120000_review_prompt_suggestions.sql` cleanly.

- [ ] **Step 4: Merge + verify deploy**

```bash
gh pr merge --merge
```

Then confirm the Vercel production deployment succeeds and `/reporting?tab=call-review` renders the new "Prompt improvements" section (empty state) with no errors.

- [ ] **Step 5: Post-ship checks**

- In prod, click "Looks right" on one real finding, confirm the bucket now shows "Suggest prompt fix (1)".
- Optionally run the new Playwright spec against prod: `npx playwright test tests/prompt-suggestions.spec.ts`.
- Update the memory file `project_call_reviewer.md` with the shipped feature.
