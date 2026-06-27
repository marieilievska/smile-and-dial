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
