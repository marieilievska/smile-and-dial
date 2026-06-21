"use client";

import { useMemo, useState, useTransition } from "react";
import {
  Bug,
  Circle,
  ExternalLink,
  Plus,
  Server,
  Sparkles,
  Trash2,
  Wand2,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  createChangelogEntry,
  deleteChangelogEntry,
  updateChangelogField,
} from "@/lib/agent-analytics/actions";
import type { ChangelogRow } from "@/lib/agent-analytics/report-data";

import { ExportCsvButton } from "./export-csv-button";

export type { ChangelogRow };

type Field =
  | "change_date"
  | "area"
  | "change_type"
  | "summary"
  | "details"
  | "status"
  | "owner"
  | "ticket_link";

const TYPES = ["Feature", "Fix", "Improvement", "Infra", "Other"];
const STATUSES = ["Open", "In progress", "Done", "Blocked"];

const STATUS_BADGE: Record<string, string> = {
  Open: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  "In progress": "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  Done: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  Blocked: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
};

const TYPE_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  Feature: Sparkles,
  Fix: Bug,
  Improvement: Wand2,
  Infra: Server,
  Other: Circle,
};

const TYPE_TONE: Record<string, string> = {
  Feature: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  Fix: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  Improvement: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  Infra: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  Other: "bg-muted text-muted-foreground",
};

/** App Changelog — a manual log of platform changes, rendered as a vertical
 *  timeline (type-icon nodes on a rail). `readOnly` shows a clean read-only
 *  timeline (public share); otherwise each entry is an editable card that
 *  saves inline, plus add / delete. */
export function ChangelogTable({
  rows,
  readOnly = false,
}: {
  rows: ChangelogRow[];
  readOnly?: boolean;
}) {
  const initial = useMemo(() => {
    const m: Record<string, string> = {};
    for (const r of rows) {
      m[`${r.id}:change_date`] = r.changeDate;
      m[`${r.id}:area`] = r.area;
      m[`${r.id}:change_type`] = r.changeType;
      m[`${r.id}:summary`] = r.summary;
      m[`${r.id}:details`] = r.details;
      m[`${r.id}:status`] = r.status;
      m[`${r.id}:owner`] = r.owner;
      m[`${r.id}:ticket_link`] = r.ticketLink;
    }
    return m;
  }, [rows]);
  const [draft, setDraft] = useState<Record<string, string>>(initial);
  const [saved, setSaved] = useState<Record<string, string>>(initial);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const get = (id: string, field: Field) => draft[`${id}:${field}`] ?? "";
  const set = (id: string, field: Field, value: string) =>
    setDraft((d) => ({ ...d, [`${id}:${field}`]: value }));

  function commit(id: string, field: Field, value: string) {
    const key = `${id}:${field}`;
    if (value === (saved[key] ?? "")) return;
    setSavingKey(key);
    startTransition(async () => {
      const res = await updateChangelogField({ id, field, value });
      setSavingKey(null);
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
      const res = await createChangelogEntry();
      if (res.error) toast.error(res.error);
    });
  }

  function remove(id: string) {
    if (!window.confirm("Delete this changelog entry?")) return;
    startTransition(async () => {
      const res = await deleteChangelogEntry({ id });
      if (res.error) toast.error(res.error);
    });
  }

  const exportRows = rows.map((r) => [
    get(r.id, "change_date"),
    get(r.id, "area"),
    get(r.id, "change_type"),
    get(r.id, "summary"),
    get(r.id, "details"),
    get(r.id, "status"),
    get(r.id, "owner"),
    get(r.id, "ticket_link"),
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
            filename="app-changelog.csv"
            headers={[
              "change_date",
              "area",
              "change_type",
              "summary",
              "details",
              "status",
              "owner",
              "ticket_link",
            ]}
            rows={exportRows}
          />
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="border-border text-muted-foreground rounded-2xl border border-dashed px-6 py-12 text-center text-sm">
          {readOnly
            ? "No entries yet."
            : "No entries yet. Click “Add entry” to start the log."}
        </div>
      ) : (
        <ol className="relative flex flex-col gap-5">
          {/* Connecting rail behind the nodes (node is size-8 → center 16px). */}
          <div
            aria-hidden
            className="bg-border absolute top-3 bottom-3 left-[15px] w-px"
          />
          {rows.map((r) => {
            const status = get(r.id, "status") || "Open";
            const type = get(r.id, "change_type");
            const Icon = TYPE_ICON[type] ?? Circle;
            const tone = TYPE_TONE[type] ?? "bg-muted text-muted-foreground";
            return (
              <li key={r.id} className="relative flex gap-4">
                <span
                  className={`ring-card relative z-10 mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full ring-4 ${tone}`}
                  title={type || "Change"}
                >
                  <Icon className="size-4" />
                </span>

                {readOnly ? (
                  <div className="flex-1 pb-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-muted-foreground text-xs tabular-nums">
                        {get(r.id, "change_date") || "—"}
                      </span>
                      <span className="text-foreground font-medium">
                        {get(r.id, "summary") || "—"}
                      </span>
                      <span
                        className={
                          "rounded-full px-2 py-0.5 text-[11px] font-medium " +
                          (STATUS_BADGE[status] ?? "bg-muted text-foreground")
                        }
                      >
                        {status}
                      </span>
                    </div>
                    {[get(r.id, "area"), type, get(r.id, "owner")].filter(
                      Boolean,
                    ).length > 0 ? (
                      <div className="text-muted-foreground mt-0.5 text-xs">
                        {[get(r.id, "area"), type, get(r.id, "owner")]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    ) : null}
                    {get(r.id, "details") ? (
                      <p className="text-muted-foreground mt-1 text-sm leading-relaxed">
                        {get(r.id, "details")}
                      </p>
                    ) : null}
                    {get(r.id, "ticket_link") ? (
                      <a
                        href={get(r.id, "ticket_link")}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary mt-1 inline-flex items-center gap-1 text-xs hover:underline"
                      >
                        View ticket <ExternalLink className="size-3" />
                      </a>
                    ) : null}
                  </div>
                ) : (
                  <div className="border-border bg-card flex flex-1 flex-col gap-3 rounded-2xl border p-4 shadow-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <Input
                        type="date"
                        value={get(r.id, "change_date")}
                        onChange={(e) =>
                          set(r.id, "change_date", e.target.value)
                        }
                        onBlur={() =>
                          commit(r.id, "change_date", get(r.id, "change_date"))
                        }
                        className="h-8 w-[9rem]"
                      />
                      <select
                        value={type}
                        onChange={(e) => {
                          set(r.id, "change_type", e.target.value);
                          commit(r.id, "change_type", e.target.value);
                        }}
                        className="border-input bg-background h-8 rounded-md border px-2 text-sm"
                      >
                        <option value="">Type…</option>
                        {type && !TYPES.includes(type) ? (
                          <option value={type}>{type}</option>
                        ) : null}
                        {TYPES.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                      <select
                        value={status}
                        onChange={(e) => {
                          set(r.id, "status", e.target.value);
                          commit(r.id, "status", e.target.value);
                        }}
                        disabled={savingKey === `${r.id}:status`}
                        className={
                          "rounded-full border-0 px-2 py-1 text-xs font-medium " +
                          (STATUS_BADGE[status] ?? "bg-muted text-foreground")
                        }
                      >
                        {STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
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
                    </div>
                    <Input
                      value={get(r.id, "summary")}
                      onChange={(e) => set(r.id, "summary", e.target.value)}
                      onBlur={() =>
                        commit(r.id, "summary", get(r.id, "summary"))
                      }
                      placeholder="What changed"
                      className="h-9 font-medium"
                    />
                    <Textarea
                      value={get(r.id, "details")}
                      onChange={(e) => set(r.id, "details", e.target.value)}
                      onBlur={() =>
                        commit(r.id, "details", get(r.id, "details"))
                      }
                      placeholder="Details…"
                      rows={2}
                      className="min-h-0 resize-y text-sm"
                    />
                    <div className="flex flex-wrap gap-2">
                      <Input
                        value={get(r.id, "area")}
                        onChange={(e) => set(r.id, "area", e.target.value)}
                        onBlur={() => commit(r.id, "area", get(r.id, "area"))}
                        placeholder="Area"
                        className="h-8 w-[10rem]"
                      />
                      <Input
                        value={get(r.id, "owner")}
                        onChange={(e) => set(r.id, "owner", e.target.value)}
                        onBlur={() => commit(r.id, "owner", get(r.id, "owner"))}
                        placeholder="Owner"
                        className="h-8 w-[8rem]"
                      />
                      <Input
                        value={get(r.id, "ticket_link")}
                        onChange={(e) =>
                          set(r.id, "ticket_link", e.target.value)
                        }
                        onBlur={() =>
                          commit(r.id, "ticket_link", get(r.id, "ticket_link"))
                        }
                        placeholder="Ticket URL"
                        className="h-8 min-w-[12rem] flex-1"
                      />
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
