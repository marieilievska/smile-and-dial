# Agent Prompt Log — per-agent association + filtering

**Date:** 2026-06-26
**Status:** Design approved, pending spec review

A follow-on to the Reporting redesign (#228–#231). Makes the Agent Prompt Log
agent-aware so each prompt/version belongs to an agent, shows an Agent column, and
filters by the selected campaign's agent — and seeds the Conversion Market
Research baseline prompt.

## Problem

`agent_prompt_log` entries are global (no agent link). With multiple agents
(AI Market Research, Conversion Market Research, …) we can't tell which agent a
logged prompt belongs to, can't filter, and the version diff mixes agents.

## Decisions (approved)

1. Add `agent_id` to `agent_prompt_log`. Migration backfills the one existing
   entry to the **AI Market Research** agent.
2. Show an **Agent** column. Combined view lists **all** agents' entries; picking
   a campaign filters to that campaign's agent. The version diff is computed
   **per agent**.
3. **Add entry** becomes an admin form with an **Agent dropdown** + date · version
   · changed · what changed · why · full prompt. Existing rows become **read-only**
   (matching the App Changelog); the diff still shows.
4. Public share: read-only, with the Agent column, filterable via the share's
   campaign picker.
5. Data (coordinator, post-migration): tag the existing entry as AI Market
   Research (in the migration) and **insert the Conversion Market Research
   baseline** prompt as a new entry for that agent.

## Non-goals

- Changing the other tabs. Dropping the unused inline update/delete prompt-log
  server actions (left in place, like the changelog's).
- Per-version approval/workflow.

## Migration (additive — apply before deploy)

`supabase/migrations/20260626150000_prompt_log_agent.sql`:

```sql
alter table public.agent_prompt_log
  add column if not exists agent_id uuid references public.agents (id) on delete set null;

-- The one existing entry is the AI Market Research prompt; tag it.
update public.agent_prompt_log
  set agent_id = (select id from public.agents where name = 'AI Market Research' limit 1)
  where agent_id is null;
```

Then hand-edit `database.types.ts`: add `agent_id: string | null` to the
`agent_prompt_log` Row, `agent_id?: string | null` to Insert/Update, and a
`agent_prompt_log_agent_id_fkey` relationship to `agents`.

## Components & changes

### Data layer — `src/lib/agent-analytics/report-data.ts`

- `PromptLogRow` gains `agentId: string | null` and `agentName: string`.
- `fetchPromptLogRows(supabase, scope)`:
  - If `scope.kind === "campaign"`, resolve the campaign's `agent_id` (one query)
    and filter `agent_prompt_log` by it; otherwise return all.
  - `.select("id, log_date, version, changed, what_changed, why, full_prompt, agent_id, agent:agents(name)")`,
    ordered `log_date desc, created_at desc`.
  - `prevPrompt` (diff baseline) = the next-older entry **with the same
    `agent_id`** that has a non-empty `full_prompt` (so diffs never cross agents).
  - Map `agentName` from the joined agent (or "" when `agent_id` is null).

### Add action — `src/lib/agent-analytics/actions.ts`

- Replace the blank-row `createPromptLogEntry()` with a form version:
  ```ts
  export async function createPromptLogEntry(input: {
    agentId: string;
    log_date: string;
    version: string;
    changed: string; // "Changed" | "No change"
    what_changed: string;
    why: string;
    full_prompt: string;
  }): Promise<{ error: string | null }>;
  ```
  Admin-checked; `agent_id = input.agentId || null`; `log_date` defaults to today
  if blank/invalid; `changed` defaults to "No change"; other fields trimmed →
  null; `revalidatePath("/reporting")`. Leave `updatePromptLogField` /
  `deletePromptLogEntry` in place (now unused by the UI).

### Table — `src/app/(app)/reporting/prompt-log-table.tsx` (rewrite)

- Props: `{ rows: PromptLogRow[]; readOnly?: boolean; agents?: { id: string; name: string }[] }`.
- Read-only rows in a list with columns: Date · Agent · Version · Changed ·
  What changed · Why · (expandable Full prompt + diff vs the same agent's previous
  version, reusing `line-diff.ts`).
- Admin "Add entry" form (when `!readOnly`): Agent dropdown (from `agents`), date,
  version, changed (select), what changed, why, full prompt (textarea). Requires an
  agent + non-empty full prompt; calls `createPromptLogEntry`.
- CSV export includes the agent name.

### Pages

- `src/app/(app)/reporting/page.tsx`: load agents `(id, name)` again (for the Add
  dropdown + passing to the table). `PromptLogTab` takes `scope` + `agents`; calls
  `fetchPromptLogRows(supabase, scope)`; passes `agents`. The tab stays always
  visible (combined = all agents).
- `src/app/share/reporting/[token]/page.tsx`: `PromptLogTab` calls
  `fetchPromptLogRows(supabase, scope)` `readOnly` (no `agents`, no Add).

## Data seeding (coordinator, after migration applies)

A one-off server-side insert (service-role key from `.env.local`, the same pattern
as the diagnostics — but a single guarded INSERT): show the current
`agent_prompt_log` rows, then insert ONE row for the Conversion Market Research
agent (`agent_id` = that agent's id, `version` = "Baseline", `changed` =
"Baseline", `what_changed` = "Initial baseline prompt", `full_prompt` = the pasted
text). Verify it appears once. This is additive; no existing rows are modified.

## Error / edge handling

- Entry with null `agent_id` (shouldn't occur after backfill) → Agent column shows
  "—"; appears only in the combined view (no campaign filter matches it).
- Campaign with no agent / agent deleted (`on delete set null`) → entries show "—".
- Add form with no agent or empty prompt → blocked client-side with a toast.

## Testing (Playwright, live env only)

Extend `tests/reporting-scope.spec.ts`: seed two agents each with a prompt-log
entry; assert the combined Prompt Log shows both with an Agent column, and that
`?scope=campaign:<A>` filters to agent A's entry only. Assert the Add form has an
agent `<select>`.

## Verification gates (run locally)

`npx tsc --noEmit`, `npx eslint`, `npm run build` — clean (only the 3 pre-existing
`twilio-*.spec.ts` errors). **One additive migration** (applied before merge);
`database.types.ts` hand-updated.
