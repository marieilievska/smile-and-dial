"use client";

import { useMemo, useState, useTransition } from "react";
import { Search } from "lucide-react";
import { toast } from "sonner";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { saveHotLeadField } from "@/lib/agent-analytics/actions";
import type { HotLeadRow } from "@/lib/agent-analytics/report-data";

import { ExportCsvButton } from "./export-csv-button";

export type { HotLeadRow };

type EditField = "status" | "owner" | "next_step" | "date_contacted";

const STATUSES = [
  "New",
  "Contacted",
  "Working",
  "Qualified",
  "Won",
  "Lost",
] as const;

const STATUS_BADGE: Record<string, string> = {
  New: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  Contacted: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  Working: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  Qualified: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  Won: "bg-emerald-600/20 text-emerald-700 dark:text-emerald-300",
  Lost: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
};

/** Label text color per status — used by the pipeline stat strip. */
const STATUS_TEXT: Record<string, string> = {
  New: "text-sky-600 dark:text-sky-400",
  Contacted: "text-violet-600 dark:text-violet-400",
  Working: "text-amber-700 dark:text-amber-400",
  Qualified: "text-emerald-600 dark:text-emerald-400",
  Won: "text-emerald-700 dark:text-emerald-300",
  Lost: "text-rose-600 dark:text-rose-400",
};

/** Left-rail color per status — a subtle per-row cue in the table. */
const STATUS_RAIL: Record<string, string> = {
  New: "border-l-sky-500",
  Contacted: "border-l-violet-500",
  Working: "border-l-amber-500",
  Qualified: "border-l-emerald-500",
  Won: "border-l-emerald-600",
  Lost: "border-l-rose-500",
};

/** Hot Leads sell list: auto-seeded yes-interest calls, worked by the team.
 *  Status / owner / next step / date contacted save inline. `readOnly` renders
 *  those cells as plain text (public share view). */
export function HotLeadsTable({
  rows,
  readOnly = false,
}: {
  rows: HotLeadRow[];
  readOnly?: boolean;
}) {
  const [statusFilter, setStatusFilter] = useState<string>("All");
  const [q, setQ] = useState("");

  const initial = useMemo(() => {
    const m: Record<string, string> = {};
    for (const r of rows) {
      m[`${r.id}:status`] = r.status;
      m[`${r.id}:owner`] = r.owner;
      m[`${r.id}:next_step`] = r.nextStep;
      m[`${r.id}:date_contacted`] = r.dateContacted;
    }
    return m;
  }, [rows]);
  const [draft, setDraft] = useState<Record<string, string>>(initial);
  const [saved, setSaved] = useState<Record<string, string>>(initial);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // Status filter options: the canonical set plus any unexpected legacy values.
  const statusOptions = useMemo(() => {
    const set = new Set<string>(STATUSES);
    for (const r of rows) if (r.status) set.add(r.status);
    return ["All", ...set];
  }, [rows]);

  // Live pipeline counts per canonical status (reflects unsaved status edits).
  const statusCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of rows) {
      const s = draft[`${r.id}:status`] ?? r.status ?? "New";
      m[s] = (m[s] ?? 0) + 1;
    }
    return m;
  }, [rows, draft]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      const status = draft[`${r.id}:status`] ?? r.status;
      if (statusFilter !== "All" && status !== statusFilter) return false;
      if (!needle) return true;
      return (
        r.company.toLowerCase().includes(needle) ||
        r.contactName.toLowerCase().includes(needle) ||
        r.whyHot.toLowerCase().includes(needle) ||
        (draft[`${r.id}:owner`] ?? "").toLowerCase().includes(needle) ||
        (draft[`${r.id}:next_step`] ?? "").toLowerCase().includes(needle)
      );
    });
  }, [rows, statusFilter, q, draft]);

  function commit(id: string, field: EditField, value: string) {
    const key = `${id}:${field}`;
    if (value === (saved[key] ?? "")) return;
    setSavingKey(key);
    startTransition(async () => {
      const res = await saveHotLeadField({ id, field, value });
      setSavingKey(null);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      setSaved((s) => ({ ...s, [key]: value }));
      toast.success("Saved");
    });
  }

  function setField(id: string, field: EditField, value: string) {
    setDraft((d) => ({ ...d, [`${id}:${field}`]: value }));
  }

  const exportRows = filtered.map((r) => [
    r.sessionDate,
    r.company,
    r.contactName,
    r.whyHot,
    r.callLength,
    r.currentAiTool,
    draft[`${r.id}:status`] ?? "",
    draft[`${r.id}:owner`] ?? "",
    draft[`${r.id}:next_step`] ?? "",
    draft[`${r.id}:date_contacted`] ?? "",
  ]);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground text-sm">
        Auto-built from every “yes” call.
        {!readOnly ? (
          <>
            {" "}
            Set the{" "}
            <span className="text-foreground font-medium">
              Status, Owner, Next step
            </span>{" "}
            and{" "}
            <span className="text-foreground font-medium">Date contacted</span>{" "}
            — edits save automatically and are never overwritten by the calling
            agent.
          </>
        ) : null}
      </p>

      {/* Pipeline stat strip */}
      <section className="border-border bg-card grid grid-cols-3 gap-x-4 gap-y-3 rounded-2xl border px-5 py-4 shadow-sm sm:grid-cols-6">
        {STATUSES.map((s) => (
          <HotStat
            key={s}
            label={s}
            value={statusCounts[s] ?? 0}
            tone={STATUS_TEXT[s]}
          />
        ))}
      </section>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="bg-muted/40 flex flex-wrap gap-0.5 rounded-lg p-0.5">
          {statusOptions.map((s) => {
            const active = s === statusFilter;
            return (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter(s)}
                className={
                  "rounded-md px-3 py-1 text-sm font-medium transition-colors " +
                  (active
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground")
                }
              >
                {s}
              </button>
            );
          })}
        </div>

        <div className="relative max-w-xs flex-1">
          <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search company, contact, why, owner…"
            className="pl-8"
          />
        </div>

        <span className="text-muted-foreground text-sm">
          {filtered.length.toLocaleString()}{" "}
          {filtered.length === 1 ? "lead" : "leads"}
        </span>

        <div className="ml-auto">
          <ExportCsvButton
            filename="market-research-hot-leads.csv"
            headers={[
              "session_date",
              "company",
              "contact_name",
              "why_hot",
              "call_length",
              "current_ai_tool",
              "status",
              "owner",
              "next_step",
              "date_contacted",
            ]}
            rows={exportRows}
          />
        </div>
      </div>

      {/* Table */}
      <div className="border-border bg-card overflow-x-auto rounded-2xl border shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-muted-foreground border-border bg-muted/30 border-b text-left text-xs">
              {[
                "Date",
                "Company",
                "Contact",
                "Why hot",
                "Length",
                "Current AI tool",
                "Status",
                "Owner",
                "Next step",
                "Contacted",
              ].map((h) => (
                <th key={h} className="px-3 py-2 font-medium whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td
                  colSpan={10}
                  className="text-muted-foreground px-3 py-8 text-center"
                >
                  No hot leads match these filters.
                </td>
              </tr>
            ) : (
              filtered.map((r) => {
                const status = draft[`${r.id}:status`] ?? r.status;
                return (
                  <tr
                    key={r.id}
                    className="border-border/60 hover:bg-muted/20 border-b align-top"
                  >
                    <td
                      className={`border-l-2 px-3 py-2 whitespace-nowrap tabular-nums ${
                        STATUS_RAIL[status] ?? "border-l-transparent"
                      }`}
                    >
                      {r.sessionDate || "—"}
                    </td>
                    <td className="px-3 py-2 font-medium">
                      {r.company || "—"}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {r.contactName || "—"}
                    </td>
                    <td className="text-foreground min-w-[16rem] px-3 py-2 leading-relaxed">
                      {r.whyHot || (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                      {r.callLength || "—"}
                    </td>
                    <td className="text-muted-foreground px-3 py-2">
                      {r.currentAiTool || "—"}
                    </td>
                    <td className="px-3 py-2">
                      {readOnly ? (
                        <span
                          className={
                            "inline-block rounded-full px-2 py-1 text-xs font-medium " +
                            (STATUS_BADGE[status] ?? "bg-muted text-foreground")
                          }
                        >
                          {status}
                        </span>
                      ) : (
                        <select
                          value={status}
                          onChange={(e) => {
                            setField(r.id, "status", e.target.value);
                            commit(r.id, "status", e.target.value);
                          }}
                          disabled={savingKey === `${r.id}:status`}
                          className={
                            "rounded-full border-0 px-2 py-1 text-xs font-medium " +
                            (STATUS_BADGE[status] ?? "bg-muted text-foreground")
                          }
                        >
                          {(STATUSES as readonly string[]).includes(
                            status,
                          ) ? null : (
                            <option value={status}>{status}</option>
                          )}
                          {STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {s}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {readOnly ? (
                        <span className="block min-w-[6rem]">
                          {draft[`${r.id}:owner`] || "—"}
                        </span>
                      ) : (
                        <Input
                          value={draft[`${r.id}:owner`] ?? ""}
                          onChange={(e) =>
                            setField(r.id, "owner", e.target.value)
                          }
                          onBlur={() =>
                            commit(r.id, "owner", draft[`${r.id}:owner`] ?? "")
                          }
                          placeholder="—"
                          className="h-8 min-w-[7rem]"
                        />
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {readOnly ? (
                        <span className="block min-w-[10rem]">
                          {draft[`${r.id}:next_step`] || "—"}
                        </span>
                      ) : (
                        <Textarea
                          value={draft[`${r.id}:next_step`] ?? ""}
                          onChange={(e) =>
                            setField(r.id, "next_step", e.target.value)
                          }
                          onBlur={() =>
                            commit(
                              r.id,
                              "next_step",
                              draft[`${r.id}:next_step`] ?? "",
                            )
                          }
                          placeholder="Add a next step…"
                          rows={2}
                          className="min-h-0 min-w-[10rem] resize-y text-sm"
                        />
                      )}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {readOnly ? (
                        <span className="tabular-nums">
                          {draft[`${r.id}:date_contacted`] || "—"}
                        </span>
                      ) : (
                        <Input
                          type="date"
                          value={draft[`${r.id}:date_contacted`] ?? ""}
                          onChange={(e) =>
                            setField(r.id, "date_contacted", e.target.value)
                          }
                          onBlur={() =>
                            commit(
                              r.id,
                              "date_contacted",
                              draft[`${r.id}:date_contacted`] ?? "",
                            )
                          }
                          className="h-8 w-[9rem]"
                        />
                      )}
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

function HotStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span
        className={`text-[10px] font-medium tracking-[0.12em] uppercase ${tone}`}
      >
        {label}
      </span>
      <span className="text-foreground text-2xl font-medium tabular-nums">
        {value.toLocaleString()}
      </span>
    </div>
  );
}
