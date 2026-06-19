"use client";

import { useMemo, useState, useTransition } from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  createChangelogEntry,
  deleteChangelogEntry,
  updateChangelogField,
} from "@/lib/agent-analytics/actions";

import { ExportCsvButton } from "./export-csv-button";

export type ChangelogRow = {
  id: string;
  changeDate: string;
  area: string;
  changeType: string;
  summary: string;
  details: string;
  status: string;
  owner: string;
  ticketLink: string;
};

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

/** App Changelog — a manual log of changes to the platform. Add a row, edit
 *  any cell inline (saves on blur / change), delete a row. Admin-only. */
export function ChangelogTable({ rows }: { rows: ChangelogRow[] }) {
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
        <Button type="button" size="sm" onClick={addEntry} disabled={isPending}>
          <Plus className="size-4" />
          Add entry
        </Button>
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

      <div className="border-border bg-card overflow-x-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-muted-foreground border-border bg-muted/30 border-b text-left text-xs">
              {[
                "Date",
                "Area",
                "Type",
                "Summary",
                "Details",
                "Status",
                "Owner",
                "Ticket",
                "",
              ].map((h, i) => (
                <th
                  key={h || `c${i}`}
                  className="px-3 py-2 font-medium whitespace-nowrap"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={9}
                  className="text-muted-foreground px-3 py-8 text-center"
                >
                  No entries yet. Click “Add entry” to start the log.
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const status = get(r.id, "status") || "Open";
                const type = get(r.id, "change_type");
                return (
                  <tr
                    key={r.id}
                    className="border-border/60 hover:bg-muted/20 border-b align-top"
                  >
                    <td className="px-3 py-2">
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
                    </td>
                    <td className="px-3 py-2">
                      <Input
                        value={get(r.id, "area")}
                        onChange={(e) => set(r.id, "area", e.target.value)}
                        onBlur={() => commit(r.id, "area", get(r.id, "area"))}
                        placeholder="—"
                        className="h-8 min-w-[7rem]"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <select
                        value={type}
                        onChange={(e) => {
                          set(r.id, "change_type", e.target.value);
                          commit(r.id, "change_type", e.target.value);
                        }}
                        className="border-input bg-background h-8 rounded-md border px-2 text-sm"
                      >
                        <option value="">—</option>
                        {type && !TYPES.includes(type) ? (
                          <option value={type}>{type}</option>
                        ) : null}
                        {TYPES.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-2">
                      <Input
                        value={get(r.id, "summary")}
                        onChange={(e) => set(r.id, "summary", e.target.value)}
                        onBlur={() =>
                          commit(r.id, "summary", get(r.id, "summary"))
                        }
                        placeholder="What changed"
                        className="h-8 min-w-[12rem]"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <Textarea
                        value={get(r.id, "details")}
                        onChange={(e) => set(r.id, "details", e.target.value)}
                        onBlur={() =>
                          commit(r.id, "details", get(r.id, "details"))
                        }
                        placeholder="Details…"
                        rows={2}
                        className="min-h-0 min-w-[12rem] resize-y text-sm"
                      />
                    </td>
                    <td className="px-3 py-2">
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
                    </td>
                    <td className="px-3 py-2">
                      <Input
                        value={get(r.id, "owner")}
                        onChange={(e) => set(r.id, "owner", e.target.value)}
                        onBlur={() => commit(r.id, "owner", get(r.id, "owner"))}
                        placeholder="—"
                        className="h-8 min-w-[6rem]"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <Input
                        value={get(r.id, "ticket_link")}
                        onChange={(e) =>
                          set(r.id, "ticket_link", e.target.value)
                        }
                        onBlur={() =>
                          commit(r.id, "ticket_link", get(r.id, "ticket_link"))
                        }
                        placeholder="URL"
                        className="h-8 min-w-[8rem]"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => remove(r.id)}
                        disabled={isPending}
                        aria-label="Delete entry"
                        className="text-muted-foreground hover:text-destructive size-8"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
