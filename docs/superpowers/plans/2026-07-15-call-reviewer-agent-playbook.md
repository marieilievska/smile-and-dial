# Call Reviewer — agent-playbook-aware review — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Feed each agent's own instructions into the Call Reviewer so it stops flagging intended behavior and surfaces where the agent went off-script (a new "Off-script" bucket).

**Architecture:** Cache each agent's effective instructions on the agent row (pulled from ElevenLabs for externally-managed agents). The review worker resolves those instructions per call and passes them into the existing two-pass `analyzeCall`, which (1) skips flags the instructions call for and (2) proposes a seeded `off_script` flag for deviations — both fact-checked by the existing Pass 2. Reuses all existing storage + bucket UI.

**Tech Stack:** TypeScript, Supabase (service role), OpenAI (existing 2-pass), ElevenLabs Convai API, Vitest.

**Spec:** [docs/superpowers/specs/2026-07-15-call-reviewer-agent-playbook-design.md](../specs/2026-07-15-call-reviewer-agent-playbook-design.md)

---

## File structure

- **Create** `supabase/migrations/20260715140000_call_review_agent_playbook.sql` — `agents.review_prompt` + `review_prompt_at`, and seed the `off_script` flag def.
- **Modify** `src/lib/supabase/database.types.ts` — add the two `agents` columns (hand-edit; gen-types needs a management token unavailable here).
- **Modify** `src/lib/elevenlabs/agents.ts` — add `fetchElevenLabsAgentPrompt(agentId)`.
- **Create** `src/lib/review/instructions.ts` — pure helpers (`rubricDefsForReview`, `truncateInstructions`, `isCacheStale`, `OFF_SCRIPT_KEY`).
- **Create** `src/lib/review/agent-prompt.ts` — `resolveAgentReviewPrompt(admin, agentId)` (DB + EL I/O, uses the pure helpers).
- **Modify** `src/lib/review/analyze.ts` — accept `instructions`, apply the playbook rules, filter `off_script` when absent.
- **Modify** `src/lib/review/worker.ts` — fetch `agent_id`, resolve instructions (per-tick cache), pass into `analyzeCall`.
- **Create** `tests/review-instructions.unit.test.ts` — pure-helper tests.

---

### Task 0: Branch + commit the spec

- [ ] **Step 1:** `git checkout -b feat/call-review-agent-playbook`
- [ ] **Step 2:**

```bash
git add docs/superpowers/specs/2026-07-15-call-reviewer-agent-playbook-design.md docs/superpowers/plans/2026-07-15-call-reviewer-agent-playbook.md
git commit -m "docs: call reviewer agent-playbook design/plan"
```

---

### Task 1: Migration + types

**Files:** Create `supabase/migrations/20260715140000_call_review_agent_playbook.sql`; Modify `src/lib/supabase/database.types.ts`.

- [ ] **Step 1: Write the migration**

```sql
-- Call Reviewer: agent-playbook-aware review. Additive.
-- Cache each agent's effective instructions for the reviewer, and seed the
-- built-in "off_script" flag (agent didn't follow its own instructions).
alter table public.agents
  add column if not exists review_prompt text,
  add column if not exists review_prompt_at timestamptz;

insert into public.review_flag_defs (key, label, lens, severity, guidance, sort_order)
values (
  'off_script',
  'Off-script — didn''t follow instructions',
  'quality',
  2,
  'The agent did not follow its own instructions/playbook for this call. Only evaluate when the agent''s instructions are provided; quote the transcript moment where it deviated.',
  100
)
on conflict (key) do nothing;
```

- [ ] **Step 2: Apply to prod**

```bash
export SUPABASE_DB_PASSWORD=$(grep '^SUPABASE_DB_PASSWORD=' .env.local | cut -d= -f2-)
printf 'y\n' | npx supabase db push --linked
```

Expected: "Applying migration 20260715140000…" then "Finished supabase db push."

- [ ] **Step 3: Hand-add the two `agents` columns to `database.types.ts`**

In the `agents` table's `Row`, `Insert`, and `Update` blocks add (Row: required-nullable; Insert/Update: optional):

- Row: `review_prompt: string | null;` and `review_prompt_at: string | null;`
- Insert & Update: `review_prompt?: string | null;` and `review_prompt_at?: string | null;`

Place each near the existing `system_prompt` entry. Verify with `grep -c "review_prompt:" src/lib/supabase/database.types.ts` → expect 1 (Row) and `grep -c "review_prompt?:" …` → expect 2.

- [ ] **Step 4: tsc + commit**

Run: `npx tsc --noEmit` → clean.

```bash
git add supabase/migrations/20260715140000_call_review_agent_playbook.sql src/lib/supabase/database.types.ts
git commit -m "feat(review): schema for agent review-prompt cache + off_script flag"
```

---

### Task 2: ElevenLabs prompt fetch

**Files:** Modify `src/lib/elevenlabs/agents.ts` (near `fetchElevenLabsAgent`, ~line 700).

- [ ] **Step 1: Add the fetch helper** (after `fetchElevenLabsAgent`)

```ts
/** Fetch an externally-managed agent's SYSTEM PROMPT text from ElevenLabs
 *  (conversation_config.agent.prompt.prompt). Returns null when not live, the
 *  key is missing, the request fails, or the prompt is empty — callers fall
 *  back to no-playbook review. Never throws. */
export async function fetchElevenLabsAgentPrompt(
  agentId: string,
): Promise<string | null> {
  if (!isLive()) return null;
  const apiKey = fetchApiKey();
  if (!apiKey) return null;
  try {
    const res = await fetch(
      `${ELEVENLABS_API}/${encodeURIComponent(agentId)}`,
      {
        headers: { "xi-api-key": apiKey },
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      conversation_config?: { agent?: { prompt?: { prompt?: string } } };
    };
    const prompt = data.conversation_config?.agent?.prompt?.prompt?.trim();
    return prompt && prompt.length > 0 ? prompt : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Verify** — `npx tsc --noEmit && npx eslint src/lib/elevenlabs/agents.ts` → clean.
- [ ] **Step 3: Commit** — `git add src/lib/elevenlabs/agents.ts && git commit -m "feat(review): fetch agent system prompt from ElevenLabs"`

---

### Task 3: Pure helpers (TDD)

**Files:** Create `src/lib/review/instructions.ts`; Test `tests/review-instructions.unit.test.ts`.

- [ ] **Step 1: Write the failing test**

`tests/review-instructions.unit.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  OFF_SCRIPT_KEY,
  isCacheStale,
  rubricDefsForReview,
  truncateInstructions,
} from "../src/lib/review/instructions";
import type { ReviewFlagDef } from "../src/lib/review/types";

const def = (key: string): ReviewFlagDef => ({
  key,
  label: key,
  lens: "quality",
  severity: 3,
  guidance: key,
});

describe("rubricDefsForReview", () => {
  const defs = [def("tool_error"), def(OFF_SCRIPT_KEY)];
  it("keeps off_script when instructions are present", () => {
    expect(rubricDefsForReview(defs, true).map((d) => d.key)).toEqual([
      "tool_error",
      OFF_SCRIPT_KEY,
    ]);
  });
  it("drops off_script when instructions are absent", () => {
    expect(rubricDefsForReview(defs, false).map((d) => d.key)).toEqual([
      "tool_error",
    ]);
  });
});

describe("truncateInstructions", () => {
  it("returns short text unchanged", () => {
    expect(truncateInstructions("hi", 10)).toBe("hi");
  });
  it("caps long text at the limit", () => {
    expect(truncateInstructions("abcdefghij", 5)).toBe("abcde");
  });
  it("passes null through", () => {
    expect(truncateInstructions(null, 5)).toBeNull();
  });
});

describe("isCacheStale", () => {
  const now = 1_000_000_000_000;
  it("stale when never cached", () => {
    expect(isCacheStale(null, now, 7)).toBe(true);
  });
  it("fresh within the window", () => {
    const oneDayAgo = new Date(now - 24 * 3600_000).toISOString();
    expect(isCacheStale(oneDayAgo, now, 7)).toBe(false);
  });
  it("stale past the window", () => {
    const tenDaysAgo = new Date(now - 10 * 24 * 3600_000).toISOString();
    expect(isCacheStale(tenDaysAgo, now, 7)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it, watch it fail** — `npx vitest run tests/review-instructions.unit.test.ts` → module not found.

- [ ] **Step 3: Implement**

`src/lib/review/instructions.ts`:

```ts
import type { ReviewFlagDef } from "./types";

/** The built-in flag for "agent didn't follow its own instructions". */
export const OFF_SCRIPT_KEY = "off_script";

/** Max chars of agent instructions fed to the reviewer (bounds token cost). */
export const INSTRUCTIONS_CAP = 6000;

/** The rubric defs the reviewer should use: off_script only makes sense when we
 *  actually have the agent's instructions to judge against. */
export function rubricDefsForReview(
  defs: ReviewFlagDef[],
  hasInstructions: boolean,
): ReviewFlagDef[] {
  return hasInstructions ? defs : defs.filter((d) => d.key !== OFF_SCRIPT_KEY);
}

/** Hard-cap instructions length. Null passes through. */
export function truncateInstructions(
  text: string | null,
  cap: number,
): string | null {
  if (text == null) return null;
  return text.length > cap ? text.slice(0, cap) : text;
}

/** True when the cached prompt is missing or older than `days`. */
export function isCacheStale(
  cachedAt: string | null,
  nowMs: number,
  days: number,
): boolean {
  if (!cachedAt) return true;
  const t = new Date(cachedAt).getTime();
  if (Number.isNaN(t)) return true;
  return nowMs - t > days * 24 * 3600_000;
}
```

- [ ] **Step 4: Run it, watch it pass** — `npx vitest run tests/review-instructions.unit.test.ts` → 8 passed.

- [ ] **Step 5: Commit** — `git add src/lib/review/instructions.ts tests/review-instructions.unit.test.ts && git commit -m "feat(review): pure playbook helpers + tests"`

---

### Task 4: The instructions resolver

**Files:** Create `src/lib/review/agent-prompt.ts`.

- [ ] **Step 1: Implement**

```ts
import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { fetchElevenLabsAgentPrompt } from "@/lib/elevenlabs/agents";
import {
  INSTRUCTIONS_CAP,
  isCacheStale,
  truncateInstructions,
} from "./instructions";

type Admin = ReturnType<typeof createClient<Database>>;

const STALE_DAYS = 7;

/** The instructions the reviewer should judge a call against, for the agent that
 *  made it. Wizard agents use their local system_prompt. Externally-managed
 *  agents' real prompt lives in ElevenLabs, so we fetch + cache it on the agent
 *  (refreshing when stale). Returns null (→ no-playbook review) on any miss. */
export async function resolveAgentReviewPrompt(
  admin: Admin,
  agentId: string | null,
): Promise<string | null> {
  if (!agentId) return null;
  const { data: agent } = await admin
    .from("agents")
    .select(
      "system_prompt, externally_managed, elevenlabs_agent_id, review_prompt, review_prompt_at",
    )
    .eq("id", agentId)
    .maybeSingle();
  if (!agent) return null;

  if (!agent.externally_managed) {
    return truncateInstructions(
      agent.system_prompt?.trim() || null,
      INSTRUCTIONS_CAP,
    );
  }

  // Externally-managed: use the cache unless it's stale/missing.
  if (
    agent.review_prompt &&
    !isCacheStale(agent.review_prompt_at, Date.now(), STALE_DAYS)
  ) {
    return truncateInstructions(agent.review_prompt, INSTRUCTIONS_CAP);
  }
  if (!agent.elevenlabs_agent_id) return null;
  const fetched = await fetchElevenLabsAgentPrompt(agent.elevenlabs_agent_id);
  if (!fetched) {
    // Fall back to a stale cache if we have one; else no playbook.
    return truncateInstructions(agent.review_prompt ?? null, INSTRUCTIONS_CAP);
  }
  await admin
    .from("agents")
    .update({
      review_prompt: fetched,
      review_prompt_at: new Date().toISOString(),
    })
    .eq("id", agentId);
  return truncateInstructions(fetched, INSTRUCTIONS_CAP);
}
```

- [ ] **Step 2: Verify** — `npx tsc --noEmit && npx eslint src/lib/review/agent-prompt.ts` → clean.
- [ ] **Step 3: Commit** — `git add src/lib/review/agent-prompt.ts && git commit -m "feat(review): resolve+cache agent instructions for review"`

---

### Task 5: Feed instructions into `analyzeCall`

**Files:** Modify `src/lib/review/analyze.ts`.

- [ ] **Step 1: Add the import + `instructions` param, apply the playbook**

Replace the top of `analyzeCall` (from its signature through the Pass 1 call) so it:

- imports `OFF_SCRIPT_KEY, rubricDefsForReview` from `./instructions`,
- accepts `instructions: string | null`,
- filters the rubric via `rubricDefsForReview(defs, Boolean(instructions))`,
- prepends the playbook block + rules to the Pass 1 user message when present.

New signature + Pass 1:

```ts
export async function analyzeCall(input: {
  transcript: string;
  extracted: string;
  defs: ReviewFlagDef[];
  instructions: string | null;
}): Promise<{ flags: VerifiedFlag[]; cost: number }> {
  const usableDefs = rubricDefsForReview(input.defs, Boolean(input.instructions));
  const rubric = buildRubricText(usableDefs);
  const validKeys = new Set(usableDefs.map((d) => d.key));

  const playbook = input.instructions
    ? `AGENT INSTRUCTIONS (the agent's playbook for this call):\n${input.instructions}\n\n` +
      `Using these instructions:\n` +
      `- Do NOT flag behavior the instructions explicitly call for — it's intended, not a defect.\n` +
      `- Propose the "${OFF_SCRIPT_KEY}" flag when the agent failed to follow a specific instruction, quoting the transcript moment.\n\n`
    : "";

  const p1 = await callOpenAiJson<{ flags: ProposedFlag[] }>({
    model: PASS1_MODEL,
    schemaName: "call_flags",
    schema: PASS1_SCHEMA,
    system:
      "You review a single sales/outreach phone call transcript between OUR AI agent and a business (the lead). " +
      "Flag ONLY things the transcript clearly supports, and quote the exact line as evidence. Never invent. " +
      "Attribution matters: the agent's pitch is NOT the lead's view.",
    user:
      playbook +
      `Rubric (flag_key (lens): meaning):\n${rubric}\n\n` +
      `Extracted call data: ${input.extracted}\n\n` +
      `Transcript:\n${input.transcript}\n\n` +
      "Return every rubric flag that applies, each with a verbatim evidence_quote from the transcript and a 0-1 confidence.",
    mock: { flags: [] },
  });
```

(Keep the rest of the function — proposed filter, the Pass 2 loop, merge — as-is except Step 2.)

Add near the top of the file:

```ts
import { OFF_SCRIPT_KEY, rubricDefsForReview } from "./instructions";
```

- [ ] **Step 2: Give Pass 2 the instructions**

In the Pass 2 loop, extend the `user` message so the verifier respects intent. Change the Pass 2 `user` to:

```ts
      user:
        (input.instructions
          ? `Agent's instructions (playbook): ${input.instructions.slice(0, 2000)}\n` +
            `A flag is INVALID if it describes behavior the instructions call for. ` +
            `"${OFF_SCRIPT_KEY}" is valid only if the agent genuinely failed to follow a specific instruction.\n\n`
          : "") +
        `Flag: ${f.flag_key} — ${def?.label}. Meaning: ${def?.guidance}\n` +
        `Claimed evidence: "${f.evidence_quote}"\n\n` +
        `Transcript:\n${input.transcript}\n\n` +
        "Is this flag genuinely true? Return agree (bool), confidence (0-1), and the correct verbatim evidence_quote.",
```

- [ ] **Step 3: Verify** — `npx tsc --noEmit && npx eslint src/lib/review/analyze.ts` → clean. (`analyzeCall` callers updated in Task 6.)
- [ ] **Step 4: Commit** — `git add src/lib/review/analyze.ts && git commit -m "feat(review): analyzeCall uses the agent playbook (+ off_script)"`

---

### Task 6: Wire the worker

**Files:** Modify `src/lib/review/worker.ts`.

- [ ] **Step 1: Import the resolver + add a per-tick cache**

Add: `import { resolveAgentReviewPrompt } from "./agent-prompt";`
Inside `runReviewTick`, after `const defs = await loadActiveFlagDefs(db);`, add:

```ts
const promptCache = new Map<string, string | null>();
async function instructionsFor(agentId: string | null): Promise<string | null> {
  const keyId = agentId ?? "";
  if (promptCache.has(keyId)) return promptCache.get(keyId) ?? null;
  const p = await resolveAgentReviewPrompt(db, agentId);
  promptCache.set(keyId, p);
  return p;
}
```

- [ ] **Step 2: Fetch `agent_id` + pass instructions**

Change the call fetch to include `agent_id`:

```ts
const { data: call } = await db
  .from("calls")
  .select("agent_id, transcript_json, extracted_data")
  .eq("id", row.call_id)
  .maybeSingle();
```

Change the `analyzeCall` call to:

```ts
const { flags, cost } = await analyzeCall({
  transcript,
  extracted: JSON.stringify(call?.extracted_data ?? {}),
  defs,
  instructions: await instructionsFor(call?.agent_id ?? null),
});
```

- [ ] **Step 3: Verify** — `npx tsc --noEmit && npx eslint src/lib/review/worker.ts` → clean.
- [ ] **Step 4: Commit** — `git add src/lib/review/worker.ts && git commit -m "feat(review): worker resolves + passes the agent playbook"`

---

### Task 7: Full local verification gate

- [ ] **Step 1**

```bash
npx tsc --noEmit
npx eslint src/lib/review src/lib/elevenlabs/agents.ts tests/review-instructions.unit.test.ts
npm run build
npx vitest run tests/review-instructions.unit.test.ts tests/review-chunk.unit.test.ts
```

Expected: all clean; instructions tests + the existing review tests pass.

---

### Task 8: Ship + re-review existing calls

- [ ] **Step 1: Push + PR + merge**

```bash
git push -u origin feat/call-review-agent-playbook
gh pr create --base main --title "feat(review): agent-playbook-aware call review" --body "<summary: cache agent instructions, feed to both passes, off_script bucket, re-queue existing calls>"
```

Then `gh pr merge <#> --merge --delete-branch` and sync `main`. (Migration already applied in Task 1.)

- [ ] **Step 2: Re-queue existing analyzed calls** (one-time, guarded, service role)

Read the current state first (count of done reviews), then, for `call_reviews` with `status='done'`: delete their `call_review_flags`, and set `status='pending'` so the cron re-analyzes them with the playbook. Do this via a scratch node script against PostgREST (service-role), printing before/after counts. The reviewer cron picks them up.

- [ ] **Step 3: Prod verification** — after re-analysis, confirm the gatekeeper example no longer carries the "didn't leave a message" flag, and that any genuine off-script call appears in the **Off-script** bucket. Report to Marija.

---

## Self-review notes

- **Spec coverage:** playbook cache (Task 1/4), EL fetch (Task 2), suppression + off_script in both passes (Task 5), off_script bucket via seed (Task 1), worker wiring (Task 6), graceful null fallback (Task 4 + `rubricDefsForReview` drops off_script when absent), re-queue (Task 8). All covered.
- **Type consistency:** `OFF_SCRIPT_KEY`, `rubricDefsForReview`, `truncateInstructions`, `isCacheStale` defined in Task 3 and consumed in Tasks 4-5; `resolveAgentReviewPrompt(admin, agentId)` defined in Task 4, called in Task 6; `analyzeCall` gains `instructions` (Task 5) and every caller (the worker, Task 6) passes it.
- **Cost:** full playbook only on Pass 1 (cheap model); Pass 2 gets a 2000-char slice; both capped at 6000 chars upstream.
