# Agent Prompt Log per-agent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Associate each Agent Prompt Log entry with an agent, show an Agent column, filter by the selected campaign's agent (combined view shows all), and add new entries via a form with an agent dropdown.

**Architecture:** Add `agent_id` to `agent_prompt_log` (migration backfills the existing entry to AI Market Research). `fetchPromptLogRows(scope)` filters by the campaign's agent and computes the version diff per-agent. The table becomes read-only rows (matching the Changelog) + an Add form with an agent dropdown.

**Tech Stack:** Next.js (App Router/RSC), Supabase (PostgREST), shadcn, Playwright (live-env).

**Testing note:** No local test runner — Playwright runs against the live env only. Verify with `npx tsc --noEmit` + `npx eslint <files>` (+ `npm run build` on page tasks). Transient mid-plan tsc errors are expected; clean (except the 3 pre-existing `twilio-*.spec.ts`) after the final task.

**Branch:** `feat/reporting-prompt-log-agent` (created; spec committed). **One additive migration** — coordinator applies it with `supabase db push` BEFORE merge, then seeds the Conversion baseline; this plan hand-edits `database.types.ts` so tsc passes.

---

## File structure

- **Create** `supabase/migrations/20260626150000_prompt_log_agent.sql` — add `agent_id` + backfill.
- **Modify** `src/lib/supabase/database.types.ts` — add `agent_id` to `agent_prompt_log`.
- **Modify** `src/lib/agent-analytics/report-data.ts` — `PromptLogRow` + `fetchPromptLogRows(scope)`.
- **Modify** `src/lib/agent-analytics/actions.ts` — `createPromptLogEntry(input)`.
- **Rewrite** `src/app/(app)/reporting/prompt-log-table.tsx` — read-only cards + Agent + Add form.
- **Modify** `src/app/(app)/reporting/page.tsx` — load agents; `PromptLogTab(scope, agents)`.
- **Modify** `src/app/share/reporting/[token]/page.tsx` — `PromptLogTab` scope-filtered, read-only.
- **Modify** `tests/reporting-scope.spec.ts` — prompt-log assertions.

---

## Task 1: Migration + types

**Files:**

- Create `supabase/migrations/20260626150000_prompt_log_agent.sql`
- Modify `src/lib/supabase/database.types.ts`

- [ ] **Step 1: Migration**

```sql
-- Associate each Agent Prompt Log entry with an agent (Reporting follow-on).
alter table public.agent_prompt_log
  add column if not exists agent_id uuid references public.agents (id) on delete set null;

-- The one existing entry is the AI Market Research prompt; tag it.
update public.agent_prompt_log
  set agent_id = (select id from public.agents where name = 'AI Market Research' limit 1)
  where agent_id is null;
```

- [ ] **Step 2: Add `agent_id` to `database.types.ts`**

In the `agent_prompt_log` table block, add `agent_id: string | null;` to `Row`, `agent_id?: string | null;` to `Insert` and `Update`, and append to its `Relationships` array:

```ts
          {
            foreignKeyName: "agent_prompt_log_agent_id_fkey";
            columns: ["agent_id"];
            isOneToOne: false;
            referencedRelation: "agents";
            referencedColumns: ["id"];
          },
```

(If `Relationships` is currently `[]`, replace it with `[ <the object above> ]`.)

- [ ] **Step 3: Verify** — `npx tsc --noEmit` (no new errors from types); `npx eslint src/lib/supabase/database.types.ts` clean.
- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260626150000_prompt_log_agent.sql src/lib/supabase/database.types.ts
git commit -m "feat(reporting): agent_prompt_log.agent_id + generated types"
```

---

## Task 2: Data layer

**Files:** Modify `src/lib/agent-analytics/report-data.ts`

- [ ] **Step 1: Extend `PromptLogRow`**

Add two fields to the `PromptLogRow` type:

```ts
agentId: string | null;
agentName: string;
```

- [ ] **Step 2: Rewrite `fetchPromptLogRows`**

```ts
export async function fetchPromptLogRows(
  supabase: DB,
  scope: ReportScope,
): Promise<PromptLogRow[]> {
  // Campaign scope → that campaign's agent only; combined → all agents.
  let agentId: string | null = null;
  if (scope.kind === "campaign") {
    const { data: c } = await supabase
      .from("campaigns")
      .select("agent_id")
      .eq("id", scope.campaignId)
      .maybeSingle();
    agentId = c?.agent_id ?? null;
    if (!agentId) return [];
  }

  let q = supabase
    .from("agent_prompt_log")
    .select(
      "id, log_date, version, changed, what_changed, why, full_prompt, agent_id, agent:agents(name)",
    )
    .order("log_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(2000);
  if (agentId) q = q.eq("agent_id", agentId);
  const { data } = await q;

  type Raw = {
    id: string;
    log_date: string | null;
    version: string | null;
    changed: string | null;
    what_changed: string | null;
    why: string | null;
    full_prompt: string | null;
    agent_id: string | null;
    agent: unknown;
  };
  const raw = (data ?? []) as unknown as Raw[];
  return raw.map((r, i): PromptLogRow => {
    // Diff baseline = the next-older entry FOR THE SAME AGENT that has a prompt.
    let prevPrompt = "";
    for (let j = i + 1; j < raw.length; j++) {
      if (raw[j].agent_id !== r.agent_id) continue;
      const fp = raw[j].full_prompt;
      if (fp && fp.trim()) {
        prevPrompt = fp;
        break;
      }
    }
    const a = Array.isArray(r.agent) ? r.agent[0] : r.agent;
    const agentName =
      a &&
      typeof a === "object" &&
      typeof (a as { name?: unknown }).name === "string"
        ? (a as { name: string }).name
        : "";
    return {
      id: r.id,
      logDate: r.log_date ?? "",
      version: r.version ?? "",
      changed: r.changed ?? "No change",
      whatChanged: r.what_changed ?? "",
      why: r.why ?? "",
      fullPrompt: r.full_prompt ?? "",
      prevPrompt,
      agentId: r.agent_id,
      agentName,
    };
  });
}
```

- [ ] **Step 3: Verify** — `npx eslint src/lib/agent-analytics/report-data.ts` clean; tsc flags page/share/table until later tasks.
- [ ] **Step 4: Commit**

```bash
git add src/lib/agent-analytics/report-data.ts
git commit -m "feat(reporting): prompt log carries agent + per-agent diff, scope-filtered"
```

---

## Task 3: Create action takes agent + fields

**Files:** Modify `src/lib/agent-analytics/actions.ts`

- [ ] **Step 1: Replace `createPromptLogEntry`**

```ts
/** Add a prompt-log entry for an agent (form-based). changed defaults to
 *  "No change"; log_date defaults to today if blank/invalid. Admin-only. */
export async function createPromptLogEntry(input: {
  agentId: string;
  log_date: string;
  version: string;
  changed: string;
  what_changed: string;
  why: string;
  full_prompt: string;
}): Promise<{ error: string | null }> {
  if (!(await isCallerAdmin())) return { error: "Admins only." };
  const t = (s: string) => s.trim() || null;
  const patch: Database["public"]["Tables"]["agent_prompt_log"]["Insert"] = {
    agent_id: input.agentId || null,
    version: t(input.version),
    changed: input.changed.trim() || "No change",
    what_changed: t(input.what_changed),
    why: t(input.why),
    full_prompt: t(input.full_prompt),
  };
  if (/^\d{4}-\d{2}-\d{2}$/.test(input.log_date))
    patch.log_date = input.log_date;
  const { error } = await adminClient().from("agent_prompt_log").insert(patch);
  if (error) return { error: "Could not add entry." };
  revalidatePath(AGENT_ANALYTICS_PATH);
  return { error: null };
}
```

Leave `updatePromptLogField` / `deletePromptLogEntry` in place (now unused by the UI).

- [ ] **Step 2: Verify** — `npx eslint src/lib/agent-analytics/actions.ts` clean; tsc flags the old table caller until Task 4.
- [ ] **Step 3: Commit**

```bash
git add src/lib/agent-analytics/actions.ts
git commit -m "feat(reporting): createPromptLogEntry takes agent + fields"
```

---

## Task 4: Rewrite the Prompt Log table

**Files:** Rewrite `src/app/(app)/reporting/prompt-log-table.tsx`

- [ ] **Step 1: Replace the whole file**

```tsx
"use client";

import { useState, useTransition } from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { createPromptLogEntry } from "@/lib/agent-analytics/actions";
import { lineDiff } from "@/lib/agent-analytics/line-diff";
import type { PromptLogRow } from "@/lib/agent-analytics/report-data";

import { ExportCsvButton } from "./export-csv-button";

export type { PromptLogRow };

type AgentOption = { id: string; name: string };

const CHANGED_OPTIONS = ["No change", "Yes"];

const EMPTY = {
  agentId: "",
  log_date: "",
  version: "",
  changed: "No change",
  what_changed: "",
  why: "",
  full_prompt: "",
};

/** Agent Prompt Log — a read-only record of each agent's prompt versions, with a
 *  per-agent line diff. Admins add entries via the form (with an agent picker);
 *  rows themselves are display-only. `readOnly` (public share) hides the form. */
export function PromptLogTable({
  rows,
  readOnly = false,
  agents = [],
}: {
  rows: PromptLogRow[];
  readOnly?: boolean;
  agents?: AgentOption[];
}) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ ...EMPTY });
  const [isPending, startTransition] = useTransition();

  function field<K extends keyof typeof EMPTY>(k: K, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function submit() {
    if (!form.agentId) {
      toast.error("Pick an agent.");
      return;
    }
    if (!form.full_prompt.trim()) {
      toast.error("Paste the full prompt.");
      return;
    }
    startTransition(async () => {
      const res = await createPromptLogEntry(form);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success("Entry added");
      setForm({ ...EMPTY });
      setAdding(false);
    });
  }

  const exportRows = rows.map((r) => [
    r.logDate,
    r.agentName,
    r.version,
    r.changed,
    r.whatChanged,
    r.why,
    r.fullPrompt,
  ]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        {!readOnly ? (
          <Button
            type="button"
            size="sm"
            onClick={() => setAdding((a) => !a)}
            disabled={isPending}
          >
            <Plus className="size-4" />
            Add entry
          </Button>
        ) : null}
        <span className="text-muted-foreground text-sm">
          {rows.length.toLocaleString()}{" "}
          {rows.length === 1 ? "entry" : "entries"}
        </span>
        <div className="ml-auto">
          <ExportCsvButton
            filename="agent-prompt-log.csv"
            headers={[
              "log_date",
              "agent",
              "version",
              "changed",
              "what_changed",
              "why",
              "full_prompt",
            ]}
            rows={exportRows}
          />
        </div>
      </div>

      {adding && !readOnly ? (
        <div className="border-border bg-card flex flex-col gap-3 rounded-2xl border p-4 shadow-sm">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">Agent</span>
              <select
                value={form.agentId}
                onChange={(e) => field("agentId", e.target.value)}
                className="border-input bg-background h-8 rounded-md border px-2 text-sm"
              >
                <option value="">Pick agent…</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">Date</span>
              <Input
                type="date"
                value={form.log_date}
                onChange={(e) => field("log_date", e.target.value)}
                className="h-8 w-[9rem]"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">Version</span>
              <Input
                value={form.version}
                onChange={(e) => field("version", e.target.value)}
                placeholder="e.g. v3.2"
                className="h-8 w-[7rem]"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">Changed?</span>
              <select
                value={form.changed}
                onChange={(e) => field("changed", e.target.value)}
                className="border-input bg-background h-8 rounded-md border px-2 text-sm"
              >
                {CHANGED_OPTIONS.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <Input
            value={form.what_changed}
            onChange={(e) => field("what_changed", e.target.value)}
            placeholder="What changed"
            className="h-9"
          />
          <Input
            value={form.why}
            onChange={(e) => field("why", e.target.value)}
            placeholder="Why / expected impact"
            className="h-9"
          />
          <Textarea
            value={form.full_prompt}
            onChange={(e) => field("full_prompt", e.target.value)}
            placeholder="Paste the full agent prompt for this version…"
            rows={10}
            className="resize-y font-mono text-xs"
          />
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              onClick={submit}
              disabled={isPending}
            >
              Save
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setForm({ ...EMPTY });
                setAdding(false);
              }}
              disabled={isPending}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="border-border bg-card text-muted-foreground rounded-2xl border px-3 py-12 text-center text-sm shadow-sm">
          No entries yet.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((r) => {
            const showDiff =
              r.changed === "Yes" && r.prevPrompt.trim().length > 0;
            return (
              <div
                key={r.id}
                className="border-border bg-card flex flex-col gap-3 rounded-2xl border p-4 shadow-sm"
              >
                <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs">
                  <span className="text-foreground font-medium">
                    {r.agentName || "—"}
                  </span>
                  <span className="text-muted-foreground tabular-nums">
                    {r.logDate || "—"}
                  </span>
                  <span className="text-muted-foreground">
                    Version{" "}
                    <span className="text-foreground font-medium">
                      {r.version || "—"}
                    </span>
                  </span>
                  <span className="text-muted-foreground">
                    Changed:{" "}
                    <span className="text-foreground font-medium">
                      {r.changed}
                    </span>
                  </span>
                </div>

                {r.whatChanged || r.why ? (
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="text-sm">
                      <div className="text-muted-foreground text-xs">
                        What changed
                      </div>
                      <div className="text-foreground">
                        {r.whatChanged || "—"}
                      </div>
                    </div>
                    <div className="text-sm">
                      <div className="text-muted-foreground text-xs">Why</div>
                      <div className="text-foreground">{r.why || "—"}</div>
                    </div>
                  </div>
                ) : null}

                <details className="text-sm">
                  <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-xs font-medium">
                    Full prompt
                  </summary>
                  <pre className="border-border bg-muted/30 mt-2 max-h-96 overflow-auto rounded-lg border p-3 font-mono text-xs whitespace-pre-wrap">
                    {r.fullPrompt || "—"}
                  </pre>
                </details>

                {showDiff ? (
                  <details className="text-sm">
                    <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-xs font-medium">
                      Diff vs previous version
                    </summary>
                    <pre className="border-border bg-muted/30 mt-2 max-h-80 overflow-auto rounded-lg border p-3 font-mono text-xs leading-relaxed">
                      {lineDiff(r.prevPrompt, r.fullPrompt).map((l, idx) => (
                        <div
                          key={idx}
                          className={
                            l.type === "add"
                              ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                              : l.type === "del"
                                ? "bg-rose-500/15 text-rose-700 dark:text-rose-300"
                                : "text-muted-foreground"
                          }
                        >
                          {l.type === "add"
                            ? "+ "
                            : l.type === "del"
                              ? "- "
                              : "  "}
                          {l.text || " "}
                        </div>
                      ))}
                    </pre>
                  </details>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify** — `npx tsc --noEmit` clean for this file; `npx eslint "src/app/(app)/reporting/prompt-log-table.tsx"` clean.
- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/reporting/prompt-log-table.tsx"
git commit -m "feat(reporting): prompt log read-only cards + agent + add form"
```

---

## Task 5: Wire the admin page

**Files:** Modify `src/app/(app)/reporting/page.tsx`

- [ ] **Step 1: Load agents for the dropdown**

Where the page loads campaigns (`supabase.from("campaigns").select("id, name").order("name")`), also load agents. Change that to a `Promise.all`:

```tsx
const [{ data: campaignRows }, { data: agentRows }] = await Promise.all([
  supabase.from("campaigns").select("id, name").order("name"),
  supabase.from("agents").select("id, name").order("name"),
]);
const campaigns = (campaignRows ?? []) as { id: string; name: string }[];
const agents = (agentRows ?? []) as { id: string; name: string }[];
```

- [ ] **Step 2: Pass scope + agents to the tab**

Change the render `<PromptLogTab />` to `<PromptLogTab scope={scope} agents={agents} />`, and replace the helper:

```tsx
async function PromptLogTab({
  scope,
  agents,
}: {
  scope: ReportScope;
  agents: { id: string; name: string }[];
}) {
  const supabase = await createClient();
  const rows = await fetchPromptLogRows(supabase, scope);
  return (
    <PromptLogTable
      key={rows.map((r) => r.id).join(",")}
      rows={rows}
      agents={agents}
    />
  );
}
```

- [ ] **Step 3: Verify** — `npx tsc --noEmit` (share still errors until Task 6); `npx eslint "src/app/(app)/reporting/page.tsx"` clean.
- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/reporting/page.tsx"
git commit -m "feat(reporting): admin prompt-log tab is agent-scoped with add dropdown"
```

---

## Task 6: Wire the public share

**Files:** Modify `src/app/share/reporting/[token]/page.tsx`

- [ ] **Step 1: Scope-filter the prompt log**

Change the prompt-log branch from `<PromptLogTable rows={await fetchPromptLogRows(supabase)} readOnly />` to:

```tsx
<PromptLogTable rows={await fetchPromptLogRows(supabase, scope)} readOnly />
```

- [ ] **Step 2: Verify (full)**
  - `npx tsc --noEmit` → only the 3 pre-existing `twilio-*.spec.ts` errors.
  - `npx eslint "src/app/(app)/reporting" "src/app/share/reporting" src/lib/agent-analytics` → clean.
  - `npm run build` → success.
- [ ] **Step 3: Commit**

```bash
git add "src/app/share/reporting/[token]/page.tsx"
git commit -m "feat(reporting): public share prompt-log is agent-scoped (read-only)"
```

---

## Task 7: Playwright contract

**Files:** Modify `tests/reporting-scope.spec.ts`

- [ ] **Step 1: Extend the spec**

Seed two agents (A, B) each with an `agent_prompt_log` row (`agent_id` set, a `full_prompt`), and a campaign whose `agent_id` is A. Assert:

- `/reporting?scope=all&tab=prompt-log` → both agents' entries appear; an Agent name for A and for B is visible.
- `/reporting?scope=campaign:<A campaign>&tab=prompt-log` → A's entry shows, B's does not.
- The Add form (admin) contains an agent `<select>` (open it via the "Add entry" button, assert a combobox/option with agent A's name).

Use `page.getByText(<agentA name>)`, `page.getByRole("combobox")` / `getByRole("option", { name: <agentA name> })`. Clean up the seeded `agent_prompt_log` rows in `afterAll`.

- [ ] **Step 2: Verify** — `npx tsc --noEmit` clean for the spec; `npx eslint tests/reporting-scope.spec.ts` clean.
- [ ] **Step 3: Commit**

```bash
git add tests/reporting-scope.spec.ts
git commit -m "test(reporting): prompt log per-agent filter + add dropdown"
```

---

## Task 8: Final verification (coordinator applies migration, seeds baseline, opens PR)

- [ ] **Step 1: Full gates**

```bash
npx tsc --noEmit      # only the 3 pre-existing twilio-*.spec.ts errors
npx eslint "src/app/(app)/reporting" "src/app/share/reporting" src/lib/agent-analytics
npm run build
```

- [ ] **Step 2: STOP — do not push.** Report to the coordinator, who will:
  1. `supabase db push --linked` (apply the migration; backfills the existing entry to AI Market Research).
  2. Seed the Conversion Market Research baseline prompt (one guarded INSERT via a service-key script).
  3. Push + open the PR; confirm with Marija before merging.

---

## Self-review notes

- **Spec coverage:** `agent_id` column + backfill (T1) ✓; Agent column + per-campaign filter + per-agent diff (T2, T4) ✓; Add form with agent dropdown, read-only rows (T3, T4) ✓; admin loads agents (T5) ✓; share read-only scope-filtered (T6) ✓; tests (T7) ✓; migration applied + baseline seeded by coordinator (T8) ✓.
- **Type consistency:** `PromptLogRow` gains `agentId`/`agentName` (set in `fetchPromptLogRows`, read in the table). `createPromptLogEntry(input)` shape matches the table's `form`/`EMPTY` (agentId, log_date, version, changed, what_changed, why, full_prompt). `fetchPromptLogRows(supabase, scope)` called by both pages. `changed` values are "No change"/"Yes" (matches the diff trigger `r.changed === "Yes"`).
- **Placeholder scan:** none.
- **Watch:** the page's agents query is re-introduced (Phase 1 had removed it). Keep the prompt-log/changelog tabs always-visible (not in `reportingTabsFor`'s gated set).
