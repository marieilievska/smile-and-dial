"use client";

import { useMemo, useState, useTransition } from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  createPromptLogEntry,
  deletePromptLogEntry,
  updatePromptLogField,
} from "@/lib/agent-analytics/actions";
import { lineDiff } from "@/lib/agent-analytics/line-diff";
import type { PromptLogRow } from "@/lib/agent-analytics/report-data";

import { ExportCsvButton } from "./export-csv-button";

export type { PromptLogRow };

type Field =
  | "log_date"
  | "version"
  | "changed"
  | "what_changed"
  | "why"
  | "full_prompt";

const CHANGED_OPTIONS = ["No change", "Yes"];

/** Agent Prompt Log — a manual record of every change to the calling agent's
 *  prompt, with a line diff vs the previous version when "Changed = Yes".
 *  Add / edit inline / delete. `readOnly` renders everything as static text
 *  (public share view). */
export function PromptLogTable({
  rows,
  readOnly = false,
}: {
  rows: PromptLogRow[];
  readOnly?: boolean;
}) {
  const initial = useMemo(() => {
    const m: Record<string, string> = {};
    for (const r of rows) {
      m[`${r.id}:log_date`] = r.logDate;
      m[`${r.id}:version`] = r.version;
      m[`${r.id}:changed`] = r.changed;
      m[`${r.id}:what_changed`] = r.whatChanged;
      m[`${r.id}:why`] = r.why;
      m[`${r.id}:full_prompt`] = r.fullPrompt;
    }
    return m;
  }, [rows]);
  const [draft, setDraft] = useState<Record<string, string>>(initial);
  const [saved, setSaved] = useState<Record<string, string>>(initial);
  const [isPending, startTransition] = useTransition();

  const get = (id: string, field: Field) => draft[`${id}:${field}`] ?? "";
  const set = (id: string, field: Field, value: string) =>
    setDraft((d) => ({ ...d, [`${id}:${field}`]: value }));

  function commit(id: string, field: Field, value: string) {
    const key = `${id}:${field}`;
    if (value === (saved[key] ?? "")) return;
    startTransition(async () => {
      const res = await updatePromptLogField({ id, field, value });
      if (res.error) {
        toast.error(res.error);
        return;
      }
      setSaved((s) => ({ ...s, [key]: value }));
      toast.success("Saved");
    });
  }

  function addEntry() {
    startTransition(async () => {
      const res = await createPromptLogEntry();
      if (res.error) toast.error(res.error);
    });
  }

  function remove(id: string) {
    if (!window.confirm("Delete this prompt-log entry?")) return;
    startTransition(async () => {
      const res = await deletePromptLogEntry({ id });
      if (res.error) toast.error(res.error);
    });
  }

  const exportRows = rows.map((r) => [
    get(r.id, "log_date"),
    get(r.id, "version"),
    get(r.id, "changed"),
    get(r.id, "what_changed"),
    get(r.id, "why"),
    get(r.id, "full_prompt"),
  ]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        {!readOnly ? (
          <Button
            type="button"
            size="sm"
            onClick={addEntry}
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

      {rows.length === 0 ? (
        <div className="border-border bg-card text-muted-foreground rounded-xl border px-3 py-8 text-center text-sm">
          {readOnly
            ? "No entries yet."
            : "No entries yet. Click “Add entry” to log a prompt version."}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((r) => {
            const changed = get(r.id, "changed") || "No change";
            const fullPrompt = get(r.id, "full_prompt");
            const showDiff =
              changed === "Yes" && r.prevPrompt.trim().length > 0;
            return (
              <div
                key={r.id}
                className="border-border bg-card flex flex-col gap-3 rounded-xl border p-4"
              >
                <div className="flex flex-wrap items-end gap-3">
                  <div className="flex flex-col gap-1 text-xs">
                    <span className="text-muted-foreground">Date</span>
                    {readOnly ? (
                      <span className="tabular-nums">
                        {get(r.id, "log_date") || "—"}
                      </span>
                    ) : (
                      <Input
                        type="date"
                        value={get(r.id, "log_date")}
                        onChange={(e) => set(r.id, "log_date", e.target.value)}
                        onBlur={() =>
                          commit(r.id, "log_date", get(r.id, "log_date"))
                        }
                        className="h-8 w-[9rem]"
                      />
                    )}
                  </div>
                  <div className="flex flex-col gap-1 text-xs">
                    <span className="text-muted-foreground">Version</span>
                    {readOnly ? (
                      <span className="font-medium">
                        {get(r.id, "version") || "—"}
                      </span>
                    ) : (
                      <Input
                        value={get(r.id, "version")}
                        onChange={(e) => set(r.id, "version", e.target.value)}
                        onBlur={() =>
                          commit(r.id, "version", get(r.id, "version"))
                        }
                        placeholder="e.g. v3.2"
                        className="h-8 w-[7rem]"
                      />
                    )}
                  </div>
                  <div className="flex flex-col gap-1 text-xs">
                    <span className="text-muted-foreground">Changed?</span>
                    {readOnly ? (
                      <span className="font-medium">{changed}</span>
                    ) : (
                      <select
                        value={changed}
                        onChange={(e) => {
                          set(r.id, "changed", e.target.value);
                          commit(r.id, "changed", e.target.value);
                        }}
                        className="border-input bg-background h-8 rounded-md border px-2 text-sm"
                      >
                        {CHANGED_OPTIONS.map((o) => (
                          <option key={o} value={o}>
                            {o}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                  {!readOnly ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => remove(r.id)}
                      disabled={isPending}
                      aria-label="Delete entry"
                      className="text-muted-foreground hover:text-destructive ml-auto size-8"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  ) : null}
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <div className="flex flex-col gap-1 text-xs">
                    <span className="text-muted-foreground">What changed</span>
                    {readOnly ? (
                      <span className="text-foreground text-sm">
                        {get(r.id, "what_changed") || "—"}
                      </span>
                    ) : (
                      <Textarea
                        value={get(r.id, "what_changed")}
                        onChange={(e) =>
                          set(r.id, "what_changed", e.target.value)
                        }
                        onBlur={() =>
                          commit(
                            r.id,
                            "what_changed",
                            get(r.id, "what_changed"),
                          )
                        }
                        placeholder="Summary of the edit…"
                        rows={2}
                        className="resize-y text-sm"
                      />
                    )}
                  </div>
                  <div className="flex flex-col gap-1 text-xs">
                    <span className="text-muted-foreground">Why</span>
                    {readOnly ? (
                      <span className="text-foreground text-sm">
                        {get(r.id, "why") || "—"}
                      </span>
                    ) : (
                      <Textarea
                        value={get(r.id, "why")}
                        onChange={(e) => set(r.id, "why", e.target.value)}
                        onBlur={() => commit(r.id, "why", get(r.id, "why"))}
                        placeholder="Reason / expected impact…"
                        rows={2}
                        className="resize-y text-sm"
                      />
                    )}
                  </div>
                </div>

                <details className="text-sm">
                  <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-xs font-medium">
                    Full prompt
                  </summary>
                  {readOnly ? (
                    <pre className="border-border mt-2 max-h-96 overflow-auto rounded-md border p-2 font-mono text-xs whitespace-pre-wrap">
                      {fullPrompt || "—"}
                    </pre>
                  ) : (
                    <Textarea
                      value={fullPrompt}
                      onChange={(e) => set(r.id, "full_prompt", e.target.value)}
                      onBlur={() =>
                        commit(r.id, "full_prompt", get(r.id, "full_prompt"))
                      }
                      placeholder="Paste the full agent prompt for this version…"
                      rows={10}
                      className="mt-2 resize-y font-mono text-xs"
                    />
                  )}
                </details>

                {showDiff ? (
                  <details className="text-sm">
                    <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-xs font-medium">
                      Diff vs previous version
                    </summary>
                    <pre className="border-border mt-2 max-h-80 overflow-auto rounded-md border p-2 font-mono text-xs leading-relaxed">
                      {lineDiff(r.prevPrompt, fullPrompt).map((l, idx) => (
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
                          {l.text || " "}
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
