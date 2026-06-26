"use client";

import { useState, useTransition } from "react";
import { ExternalLink, Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { createChangelogEntry } from "@/lib/agent-analytics/actions";
import type { ChangelogRow } from "@/lib/agent-analytics/report-data";

import { ExportCsvButton } from "./export-csv-button";

export type { ChangelogRow };

const TYPES = ["Feature", "Fix", "Improvement", "Infra", "Other"];
const STATUSES = ["Open", "In progress", "Done", "Blocked"];

const STATUS_BADGE: Record<string, string> = {
  Open: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  "In progress": "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  Done: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  Blocked: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
};

const EMPTY = {
  change_date: "",
  change_type: "",
  status: "Open",
  summary: "",
  details: "",
  area: "",
  ticket_link: "",
};

/** App Changelog — a manual, read-only log of platform changes (newest first).
 *  Admins can add an entry via the inline form; rows themselves are display-only.
 *  `readOnly` (public share) hides the Add form entirely. */
export function ChangelogTable({
  rows,
  readOnly = false,
}: {
  rows: ChangelogRow[];
  readOnly?: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ ...EMPTY });
  const [isPending, startTransition] = useTransition();

  function field<K extends keyof typeof EMPTY>(k: K, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function submit() {
    startTransition(async () => {
      const res = await createChangelogEntry(form);
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
    r.changeDate,
    r.area,
    r.changeType,
    r.summary,
    r.details,
    r.status,
    r.ticketLink,
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
            filename="app-changelog.csv"
            headers={[
              "change_date",
              "area",
              "change_type",
              "summary",
              "details",
              "status",
              "ticket_link",
            ]}
            rows={exportRows}
          />
        </div>
      </div>

      {adding && !readOnly ? (
        <div className="border-border bg-card flex flex-col gap-3 rounded-2xl border p-4 shadow-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="date"
              value={form.change_date}
              onChange={(e) => field("change_date", e.target.value)}
              className="h-8 w-[9rem]"
            />
            <select
              value={form.change_type}
              onChange={(e) => field("change_type", e.target.value)}
              className="border-input bg-background h-8 rounded-md border px-2 text-sm"
            >
              <option value="">Type…</option>
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <select
              value={form.status}
              onChange={(e) => field("status", e.target.value)}
              className="border-input bg-background h-8 rounded-md border px-2 text-sm"
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <Input
            value={form.summary}
            onChange={(e) => field("summary", e.target.value)}
            placeholder="What changed"
            className="h-9 font-medium"
          />
          <Textarea
            value={form.details}
            onChange={(e) => field("details", e.target.value)}
            placeholder="Details…"
            rows={2}
            className="min-h-0 resize-y text-sm"
          />
          <div className="flex flex-wrap gap-2">
            <Input
              value={form.area}
              onChange={(e) => field("area", e.target.value)}
              placeholder="Area"
              className="h-8 w-[10rem]"
            />
            <Input
              value={form.ticket_link}
              onChange={(e) => field("ticket_link", e.target.value)}
              placeholder="Ticket URL"
              className="h-8 min-w-[12rem] flex-1"
            />
          </div>
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
        <div className="border-border text-muted-foreground rounded-2xl border border-dashed px-6 py-12 text-center text-sm">
          No entries yet.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-muted-foreground bg-muted/30 text-left text-[10px] tracking-wide uppercase">
                <th className="rounded-l-md px-3 py-2 font-medium whitespace-nowrap">
                  Date
                </th>
                <th className="px-3 py-2 font-medium whitespace-nowrap">
                  Type
                </th>
                <th className="px-3 py-2 font-medium whitespace-nowrap">
                  Status
                </th>
                <th className="px-3 py-2 font-medium">Summary</th>
                <th className="px-3 py-2 font-medium">Details</th>
                <th className="px-3 py-2 font-medium whitespace-nowrap">
                  Area
                </th>
                <th className="rounded-r-md px-3 py-2 font-medium whitespace-nowrap">
                  Ticket
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className="border-border/60 hover:bg-muted/30 border-b align-top transition-colors"
                >
                  <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                    {r.changeDate || "—"}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {r.changeType || "—"}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span
                      className={
                        "rounded-full px-2 py-0.5 text-[11px] font-medium " +
                        (STATUS_BADGE[r.status] ?? "bg-muted text-foreground")
                      }
                    >
                      {r.status || "Open"}
                    </span>
                  </td>
                  <td className="text-foreground px-3 py-2 font-medium">
                    {r.summary || "—"}
                  </td>
                  <td className="text-muted-foreground px-3 py-2">
                    {r.details || "—"}
                  </td>
                  <td className="text-muted-foreground px-3 py-2 whitespace-nowrap">
                    {r.area || "—"}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {r.ticketLink ? (
                      <a
                        href={r.ticketLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary inline-flex items-center gap-1 hover:underline"
                      >
                        View <ExternalLink className="size-3" />
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
