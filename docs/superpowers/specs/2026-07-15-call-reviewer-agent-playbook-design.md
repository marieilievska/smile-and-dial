# Call Reviewer — agent-playbook-aware review — design

- **Date:** 2026-07-15
- **Status:** Approved for planning
- **Approach:** A (feed the agent's instructions into the existing 2-pass reviewer + add one "Off-script" bucket)

## Problem (root cause, confirmed in code)

The Call Reviewer analyzes each call with only three inputs — the transcript, the
post-call `extracted_data`, and a **generic** workspace rubric (`review_flag_defs`)
— see `analyzeCall` in [`src/lib/review/analyze.ts`](../../../src/lib/review/analyze.ts)
and the worker in [`src/lib/review/worker.ts`](../../../src/lib/review/worker.ts)
(the `calls` select fetches only `transcript_json, extracted_data`). It **never
sees what the agent was instructed to do**, so intended behavior gets flagged as a
problem. Example: the agent's playbook says "if the owner isn't available, engage
the gatekeeper with a question and push for the follow-up instead of leaving a
message" — the reviewer flags _"talked to gatekeeper, didn't leave a message."_

## Goal

Give the reviewer the agent's own instructions so it can (1) **not flag intended
behavior** and (2) **surface where the agent went off-script**, reusing the
existing two-pass pipeline, flag storage, and bucket UI.

## Key constraint found

The one agent ("Speed to Lead") is **`externally_managed = true`** and its
`agents.system_prompt` in our DB is **empty** — the real prompt lives in
ElevenLabs. `fetchElevenLabsAgent` (`src/lib/elevenlabs/agents.ts`) already GETs
the agent config but only reads `.prompt.llm`; the system prompt is at
`conversation_config.agent.prompt.prompt`. So for externally-managed agents we
must **fetch the prompt from ElevenLabs and cache it**. Wizard-built agents use
their local `system_prompt`. Every `calls` row has an `agent_id` (verified: 26/26),
so the call→agent link is clean.

## Design

### 1. Cache each agent's effective review instructions

- **Migration (additive):**
  - `agents.review_prompt text` — the cached instructions the reviewer uses.
  - `agents.review_prompt_at timestamptz` — when it was cached (for staleness).
- **Resolver** — new `resolveAgentReviewPrompt(admin, agentId)` in `src/lib/review/`:
  - Load the agent (`system_prompt, externally_managed, elevenlabs_agent_id,
review_prompt, review_prompt_at`).
  - **Wizard agent** (`externally_managed = false`): instructions = `system_prompt`.
  - **Externally-managed:** if `review_prompt` is missing **or** stale (older than
    7 days), fetch from ElevenLabs (`conversation_config.agent.prompt.prompt`) and
    cache to `review_prompt` + `review_prompt_at`; otherwise use the cache.
  - Truncate to a safe cap (~6000 chars) before returning.
  - **Graceful fallback:** any failure / empty → return `null`. The reviewer then
    behaves exactly as today (no playbook, no off-script check). Never throws.
- **ElevenLabs fetch:** extend `fetchElevenLabsAgent` to also return `prompt`
  (from `conversation_config.agent.prompt.prompt`), or add a small
  `fetchElevenLabsAgentPrompt(agentId)`. Mocked when `ELEVENLABS_LIVE != live`.

### 2. Feed the playbook into the reviewer (`analyze.ts`)

- `analyzeCall` gains an optional `instructions: string | null`.
- **Pass 1** — when `instructions` is present, its prompt gains an **AGENT
  INSTRUCTIONS (playbook)** section and two rules:
  1. **Do NOT propose a rubric flag for behavior the instructions explicitly call
     for** — that is intended, not a defect.
  2. **Propose an `off_script` flag** when the agent failed to follow a specific
     instruction, quoting the transcript moment as evidence.
  - The `off_script` flag is a seeded rubric def (see §3), so `buildRubricText`
    already lists it. When `instructions` is `null`, `analyzeCall` **filters
    `off_script` out of the rubric** so it's never proposed without a playbook.
- **Pass 2** (verify) — also receives the (trimmed) instructions so it can judge
  "is this genuinely a defect given the agent's intent?" for rubric flags and "did
  the agent genuinely deviate?" for `off_script`. Existing `mergeVerification`
  logic is unchanged (refuted → dropped; low confidence → needs_review).
- **Cost:** the full playbook rides on Pass 1's cheap model (`PASS1_MODEL`); Pass 2
  gets a trimmed copy. Capping (§1) bounds worst case.

### 3. The "Off-script" bucket

- **Seed one flag def** in `review_flag_defs` (migration): `key = "off_script"`,
  `label = "Off-script — didn't follow instructions"`, `lens = "quality"`,
  `active = true`, `is_candidate = false`, a mid `severity`, `guidance =
"The agent did not follow its own instructions/playbook for this call
(evidence quotes the moment)."`
- No change to `call_review_flags` — `off_script` is just another `flag_key`, so it
  flows through the exact same storage, verification, buckets, and needs-review
  queue. It appears automatically as a new bucket in the reviewing UI.

### 4. Worker wiring (`worker.ts`)

- Add `agent_id` to the `calls` select.
- Resolve instructions via `resolveAgentReviewPrompt`, with a **per-tick cache**
  keyed by `agent_id` (so we resolve once per agent per tick, not per call).
- Pass `instructions` into `analyzeCall`.

### 5. Rollout — re-review existing calls

Already-analyzed calls were judged without the playbook. As a one-time step:
for the done reviews, **delete their existing `call_review_flags`** and set
`call_reviews.status = 'pending'` so the worker re-analyzes them with the playbook
— clearing false alarms and surfacing genuine off-script calls. (Deleting first is
required: a re-run only upserts newly-proposed flags; it won't remove a flag it no
longer proposes.)

## Out of scope (YAGNI)

- Per-agent custom rubrics (Option C) — not building.
- A separate adherence report screen (Option B) — reusing the bucket UI instead.
- Structured "which instruction #" mapping — for v1 the evidence quote + the
  `off_script` label are enough.
- Auto-refreshing the cached prompt on a schedule — on-demand staleness (7 days)
  in the resolver is enough; a manual re-fetch can be added later if needed.

## Testing

- **Unit (vitest):**
  - `resolveAgentReviewPrompt` selection logic — wizard → `system_prompt`;
    externally-managed with a fresh cache → cache; truncation cap applied. (Mock
    the EL fetch + DB.)
  - `analyzeCall` drops `off_script` from the rubric when `instructions` is null
    (pure filter behavior).
  - `mergeVerification` unchanged (existing test stays green).
- **Prod verification:** after deploy + re-queue, confirm the gatekeeper example no
  longer flags "didn't leave a message," and that a deliberately off-script call
  lands in the Off-script bucket.

## Rollout / sequencing

Single PR: additive migration (`agents.review_prompt`/`_at` + the `off_script`
seed) + the resolver + EL fetch + `analyze.ts` + `worker.ts`. Ships behind the
existing reviewer cron; the migration is additive (safe before/after deploy). The
re-queue of existing calls runs after deploy.
