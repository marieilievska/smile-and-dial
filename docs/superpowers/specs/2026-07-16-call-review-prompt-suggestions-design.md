# Call Review → Prompt Improvement Suggestions — Design

**Date:** 2026-07-16
**Status:** Approved by Marija (design conversation, 2026-07-16)

## Context & goal

The Call Reviewer flags mistakes on human-reached calls, and the curation UX
(PR #270) lets Marija confirm each finding ("Looks right") or reject it
("False alarm"). Today, turning a confirmed mistake into a better agent prompt
is fully manual: she copies the whole system prompt into Claude, pastes an
example of the mistake, gets back a targeted improvement, and applies it by
hand in the ElevenLabs dashboard.

This feature closes that loop inside Smile & Dial: **human-approved findings +
the agent's live prompt → an AI-drafted, precisely-targeted prompt edit →
Marija reviews (and can reword) the exact diff → one click applies it to the
live agent, logs it, and keeps a revert path.** Nothing changes on the agent
without explicit human approval, and the AI is structurally incapable of
rewriting parts of the prompt it wasn't asked to touch.

## Decisions made (design conversation)

| Question                                      | Decision                                                                                                                                                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| When/where are suggestions generated?         | **On-demand, per problem type**: a "Suggest prompt fix" button on each flag bucket in Reporting → Call review. No background generation.                                                                  |
| Which findings feed a suggestion?             | **Only flags a human explicitly clicked "Looks right" on.** AI-assigned `confirmed` status alone is NOT enough. Requires recording human curation (new columns).                                          |
| How does an approved change reach ElevenLabs? | **The app applies it**: prompt-text-only read-modify-write PATCH, freshness check first, auto-log to Agent Prompt Log, one-click revert.                                                                  |
| How may the AI express its change?            | **Anchored edits only**: replace-exact-passage / insert-after-exact-passage / append. Anchors must match the current prompt exactly once or the suggestion is auto-rejected. Never a full-prompt rewrite. |

## User flow

1. Marija curates findings in the call modal as today ("Looks right" / "False
   alarm"). From this feature on, those clicks are recorded as _human_
   decisions (`curated_by/curated_at`).
2. In Reporting → Call review, a bucket with ≥1 approved, not-yet-used example
   shows **"Suggest prompt fix (N approved examples)"**. Clicking it opens a
   small dialog: agent picker (preselected when only one agent has approved
   examples in the bucket) + Generate button.
3. Generation fetches the agent's **live** prompt (fresh from ElevenLabs for
   externally-managed agents; `agents.system_prompt` for wizard agents), pools
   up to the 20 most recent approved examples (evidence quotes + flag
   definition), and asks OpenAI for ONE targeted change expressed as anchored
   edits + a plain-English rationale + a short summary.
4. The suggestion appears in a new **"Prompt improvements"** section on the
   same tab: per-edit diff (old text red / new text green; insertions show
   their anchor context), rationale, contributing calls, and an editable
   textarea for each edit's new text (final-wording control).
5. **Approve & apply** → freshness check → ElevenLabs write → Agent Prompt Log
   entry → reviewer playbook cache updated → suggestion marked applied.
   **Dismiss** → suggestion archived; its examples return to the available
   pool.
6. Applied suggestions keep a **Revert** button (same safety checks, its own
   log entry, examples returned to the pool).

## Data model (one additive migration)

New table `review_prompt_suggestions`:

```sql
create table public.review_prompt_suggestions (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents(id) on delete cascade,
  flag_key text not null references public.review_flag_defs(key),
  based_on_prompt text not null,   -- exact live prompt the edits were drafted against
  proposed_prompt text not null,   -- based_on_prompt with edits applied (recomputed if texts are edited)
  edits jsonb not null,            -- [{type: 'replace'|'insert_after'|'append', anchor: string, text: string}]
  rationale text not null,         -- plain-English why (shown on the card)
  summary text not null,           -- one-line what-changed (used in the prompt log)
  example_count int not null default 0,
  status text not null default 'proposed',  -- proposed | applied | dismissed | reverted
  model text,
  cost numeric not null default 0,
  created_at timestamptz not null default now(),
  decided_by uuid references public.profiles(id) on delete set null,
  decided_at timestamptz,
  applied_at timestamptz,
  reverted_at timestamptz
);
```

RLS: admin-only read via `is_admin`, writes via service-role server actions —
identical pattern to `call_reviews` / `agent_prompt_log`.

New columns on `call_review_flags`:

```sql
alter table public.call_review_flags
  add column curated_by uuid references public.profiles(id) on delete set null,
  add column curated_at timestamptz,
  add column suggestion_id uuid references public.review_prompt_suggestions(id) on delete set null;
```

- `curated_by/curated_at` — stamped by `setFlagStatus` on every human
  Looks-right/False-alarm click. **Human-approved** = `status = 'confirmed'
AND curated_at IS NOT NULL`.
- `suggestion_id` — set when a suggestion consumes the flag as an example, so
  the same example never feeds two suggestions. Cleared on dismiss/revert.

**No backfill:** flags curated before this ships have no `curated_at`, so
approved-example counts start at zero until findings are (re-)confirmed. This
is acceptable and will be visible in the UI copy. (Pre-existing `rejected`
flags could in principle be backfilled as human decisions, but rejected flags
never feed suggestions, so there is no value.)

## Generation (server action `generatePromptSuggestion({ flagKey, agentId })`)

Lives in `src/lib/review/suggest.ts`, exposed via `src/lib/review/actions.ts`.
Admin-only (reuses `currentAdminId`).

1. Resolve the agent's **current full prompt**:
   - Externally-managed: `fetchElevenLabsAgentPrompt` (fresh call, cache
     bypassed). Fails friendly if unavailable ("Couldn't read the live
     prompt from ElevenLabs.").
   - Wizard: `agents.system_prompt`.
   - **Use the raw, untruncated text.** (`resolveAgentReviewPrompt`'s
     `INSTRUCTIONS_CAP` truncation is for per-call review cost control and
     must NOT be applied here — anchors need the full prompt.)
2. Load available examples: flags with `flag_key`, `status='confirmed'`,
   `curated_at IS NOT NULL`, `suggestion_id IS NULL`, whose call belongs to
   `agentId`. Most recent 20, with evidence quotes + the flag def's
   label/guidance. Zero available → friendly error.
3. Call OpenAI via the existing `callOpenAiJson` (strict JSON schema,
   `PASS2_MODEL` = gpt-5.4, mock when no key). System instructions: you are a
   conservative prompt editor; propose the SMALLEST change that addresses the
   pattern; preserve persona/voice/structure and all `{{dynamic_variable}}`
   placeholders verbatim; anchors must be verbatim, unique substrings of the
   prompt; never remove content you weren't asked to change. Output schema:
   `{ rationale, summary, edits: [{ type, anchor, text }] }`.
4. **Validate mechanically**: every `replace`/`insert_after` anchor must occur
   **exactly once** in the current prompt (`append` ignores its anchor);
   edit texts non-empty for replace/insert/append. Apply the edits to compute
   `proposed_prompt`. On validation failure: one automatic retry with the
   validator's feedback appended; second failure → friendly error, nothing
   saved.
5. Insert the suggestion row (`based_on_prompt` = the resolved prompt,
   `example_count`, `model`, `cost`) and stamp `suggestion_id` on the
   contributing flags. Revalidate `/reporting`.

Cost is recorded on the suggestion row. (Folding it into the Costs page's
OpenAI line is out of scope for v1 — that line aggregates per-call
`cost_breakdown`, and a suggestion is not a call.)

## Apply (server action `applyPromptSuggestion({ suggestionId, editedTexts? })`)

1. Suggestion must be `proposed`. If `editedTexts` supplied (same
   length/order as `edits`), replace each edit's `text`, re-run the full
   validation (anchors exactly-once, texts non-empty) against
   `based_on_prompt`, recompute + persist `proposed_prompt`/`edits`.
2. **Freshness check**: re-resolve the agent's current prompt (same source as
   generation). It must equal `based_on_prompt` (both sides trimmed). On
   mismatch → no write; UI shows "The agent's prompt changed since this was
   drafted — dismiss and regenerate."
3. **Write, ElevenLabs first**:
   - Externally-managed: new helper `updateElevenLabsAgentPrompt(agentId,
newPrompt)` in `src/lib/elevenlabs/agents.ts` — GET the full agent
     config, PATCH it back byte-identical except
     `conversation_config.agent.prompt.prompt`, following
     `applyConnectedAgentIntegration`'s read-modify-write conventions
     (mocked off-live; a rejected PATCH is a no-op, never partial).
   - Wizard: update `agents.system_prompt`, then re-sync through the existing
     `syncAgentToElevenLabs` pipeline.
4. Only after ElevenLabs succeeds: update `agents.review_prompt/_at` to the
   new prompt (reviewer judges future calls against it immediately); insert an
   `agent_prompt_log` row (`agent_id`, `changed='Changed'`,
   `what_changed=summary`, `why = rationale + "Based on N approved examples
in bucket <label>."`, `full_prompt = proposed_prompt`); mark the suggestion
   `applied` (+`decided_by/decided_at/applied_at`). Revalidate `/reporting`.
5. Any ElevenLabs failure → friendly error, zero DB writes.

## Dismiss / Revert

- **Dismiss** (`dismissPromptSuggestion`): status → `dismissed`,
  `decided_by/decided_at`; clear `suggestion_id` on its flags (examples become
  available again).
- **Revert** (`revertPromptSuggestion`): only for `applied` suggestions.
  Freshness check: live prompt must equal `proposed_prompt` (i.e. nothing else
  changed it since) — else refuse with a warning. Write `based_on_prompt` back
  through the same machinery, insert a prompt-log entry (`what_changed =
"Reverted: " + summary`), status → `reverted` (+`reverted_at`), restore the
  reviewer cache to `based_on_prompt`, clear the flags' `suggestion_id`.

## UI (Reporting → Call review tab)

- **Bucket cards**: "Suggest prompt fix (N)" appears when the bucket has ≥1
  available approved example. Opens the agent-picker dialog (radio list with
  per-agent counts; preselected when single) → Generate (button disabled while
  pending to prevent double-generation).
- **New "Prompt improvements" section** (third section, after "Review flagged
  calls" and "The AI's checklist"): suggestion cards, `proposed` first.
  Each card: agent name, bucket label, created date, status chip, rationale,
  per-edit diff blocks (replace: red old / green new; insert_after: dimmed
  anchor context + green insertion; append: green block labeled "added at the
  end"), editable textarea per edit's new text, contributing-call links,
  and actions by status — proposed: **Approve & apply** / **Dismiss**;
  applied: applied stamp + **Revert**; dismissed/reverted: stamp only.
- Empty state explains the pipeline: "Confirm findings with 'Looks right' in
  a call's review panel, then generate a fix here."
- The call modal itself doesn't change visually — `setFlagStatus` just starts
  stamping curation.

## Safety rails (summary)

1. Anchored edits only; anchors validated exactly-once; auto-reject otherwise.
2. Input gate: only explicitly human-approved findings feed generation.
3. Output gate: nothing applies without a human clicking Approve on an exact
   diff (with editable final wording).
4. Freshness check at apply AND revert — the app never overwrites a prompt
   state it hasn't shown the human.
5. ElevenLabs write first; DB bookkeeping only after success; failures are
   no-ops.
6. Prompt-text-only PATCH via read-modify-write (webhooks/tools/voice
   untouched) — same proven pattern as `applyConnectedAgentIntegration`.
7. Admin-only server actions throughout; RLS matches existing review tables.
8. Full paper trail: every apply/revert writes an Agent Prompt Log entry with
   the full prompt text, and the suggestion row keeps before/after forever.

## Dev / mock behavior

- No `OPENAI_API_KEY` → `callOpenAiJson` returns a deterministic mock
  suggestion so the UI flow is exercisable free.
- `ELEVENLABS_LIVE` not `live` → live-prompt fetch returns null: generation
  for externally-managed agents errors gracefully; wizard agents work end to
  end against the mocked sync.

## Testing

- Playwright contract spec (`tests/`): suggest button only with approved
  examples; suggestion card renders diff + rationale; approve/dismiss/revert
  state transitions. (Specs run against the live environment per project
  practice — no CI gate; local `npx tsc --noEmit`, `npx eslint`, `npm run
build` must be clean.)
- Anchor-validation unit coverage if a natural spot exists (pure function in
  `suggest.ts`).

## Out of scope (v1, deliberate)

- Scheduled/automatic suggestion generation.
- Effectiveness tracking (bucket shrink after a change) — data supports it
  later via `applied_at`.
- Multi-bucket/combined suggestions.
- Costs-page line for suggestion spend (recorded per-row only).
- Backfilling human curation for pre-feature flags.

## Implementation pointers (for the plan)

- `src/lib/review/actions.ts` — curation stamping in `setFlagStatus`; new
  server actions (generate/apply/dismiss/revert).
- `src/lib/review/suggest.ts` (new) — prompt resolution, example pooling,
  OpenAI call, anchor validation, edit application (pure + testable).
- `src/lib/elevenlabs/agents.ts` — `updateElevenLabsAgentPrompt`.
- `src/lib/review/agent-prompt.ts` — reference for prompt resolution;
  do not reuse its truncation.
- Reporting call-review tab components (from PR #270) — bucket button, new
  section, suggestion card + diff rendering.
- `src/lib/supabase/database.types.ts` — new table/columns.
- Agent Prompt Log insert — reuse/extend the existing reporting action that
  writes `agent_prompt_log`.
