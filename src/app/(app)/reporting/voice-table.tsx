"use client";

import { useMemo, useState, useTransition } from "react";
import { Search } from "lucide-react";
import { toast } from "sonner";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { saveCallAnnotation } from "@/lib/agent-analytics/actions";
import type { VoiceRow } from "@/lib/agent-analytics/report-data";

import { ExportCsvButton } from "./export-csv-button";

export type { VoiceRow };

type InterestFilter = "all" | "yes" | "maybe" | "no";

const INTEREST_PILLS: { key: InterestFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "yes", label: "Yes" },
  { key: "maybe", label: "Maybe" },
  { key: "no", label: "No" },
];

const INTEREST_BADGE: Record<VoiceRow["interest"], string> = {
  yes: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  maybe: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  no: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
};

/** Voice of Customer: every call that has an interest answer, with the owner's
 *  verbatim reason and two operator-editable annotation fields (theme +
 *  suggested action) that save inline to the call. `readOnly` renders the
 *  annotation cells as plain text (public share view). */
export function VoiceTable({
  rows,
  readOnly = false,
  scopeSlug = "all-agents",
  note,
}: {
  rows: VoiceRow[];
  readOnly?: boolean;
  scopeSlug?: string;
  /** Optional clarifier shown above the table (e.g. in the combined view). */
  note?: string;
}) {
  const [interest, setInterest] = useState<InterestFilter>("all");
  const [q, setQ] = useState("");

  // Working text per editable cell, keyed `${id}:${field}`. `saved` tracks the
  // last value persisted to the DB so a blur with no change is a no-op.
  const initial = useMemo(() => {
    const m: Record<string, string> = {};
    for (const r of rows) {
      m[`${r.id}:theme`] = r.theme;
      m[`${r.id}:suggested_action`] = r.suggestedAction;
    }
    return m;
  }, [rows]);
  const [draft, setDraft] = useState<Record<string, string>>(initial);
  const [saved, setSaved] = useState<Record<string, string>>(initial);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (interest !== "all" && r.interest !== interest) return false;
      if (!needle) return true;
      return (
        r.company.toLowerCase().includes(needle) ||
        r.reason.toLowerCase().includes(needle) ||
        r.list.toLowerCase().includes(needle)
      );
    });
  }, [rows, interest, q]);

  // Overall interest mix across ALL rows (stable summary, independent of the
  // interest/search filters below).
  const counts = useMemo(() => {
    let yes = 0;
    let maybe = 0;
    let no = 0;
    for (const r of rows) {
      if (r.interest === "yes") yes++;
      else if (r.interest === "maybe") maybe++;
      else no++;
    }
    return { yes, maybe, no, total: rows.length };
  }, [rows]);
  const barPct = (n: number) =>
    counts.total > 0 ? `${(n / counts.total) * 100}%` : "0%";

  function commit(id: string, field: "theme" | "suggested_action") {
    const key = `${id}:${field}`;
    const value = draft[key] ?? "";
    if (value === (saved[key] ?? "")) return; // unchanged — nothing to save
    setSavingKey(key);
    startTransition(async () => {
      const res = await saveCallAnnotation({ callId: id, field, value });
      setSavingKey(null);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      setSaved((s) => ({ ...s, [key]: value }));
      toast.success(
        field === "theme" ? "Theme saved" : "Suggested action saved",
      );
    });
  }

  const exportRows = filtered.map((r) => [
    r.day,
    r.company,
    r.list,
    r.interest,
    r.reason,
    draft[`${r.id}:theme`] ?? "",
    draft[`${r.id}:suggested_action`] ?? "",
  ]);

  return (
    <div className="flex flex-col gap-4">
      {note ? (
        <p className="border-border bg-muted/20 text-muted-foreground rounded-lg border px-3 py-2 text-sm">
          {note}
        </p>
      ) : null}
      <p className="text-muted-foreground text-sm">
        Every call with an interest answer, in the owner’s own words.
        {!readOnly ? (
          <>
            {" "}
            Edit the <span className="text-foreground font-medium">
              Theme
            </span>{" "}
            and{" "}
            <span className="text-foreground font-medium">
              Suggested action
            </span>{" "}
            cells — they save automatically when you click away.
          </>
        ) : null}
      </p>

      {/* Interest mix summary */}
      <section className="border-border bg-card flex flex-col gap-3 rounded-2xl border p-5 shadow-sm">
        <div className="flex flex-wrap gap-x-8 gap-y-2">
          <VoiceStat
            label="Yes"
            value={counts.yes}
            tone="text-emerald-600 dark:text-emerald-400"
          />
          <VoiceStat
            label="Maybe"
            value={counts.maybe}
            tone="text-amber-700 dark:text-amber-400"
          />
          <VoiceStat
            label="No"
            value={counts.no}
            tone="text-rose-600 dark:text-rose-400"
          />
        </div>
        <div className="bg-muted flex h-2 overflow-hidden rounded-full">
          <div
            className="bg-emerald-500"
            style={{ width: barPct(counts.yes) }}
          />
          <div
            className="bg-amber-500"
            style={{ width: barPct(counts.maybe) }}
          />
          <div className="bg-rose-500" style={{ width: barPct(counts.no) }} />
        </div>
      </section>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="bg-muted/40 inline-flex rounded-lg p-0.5">
          {INTEREST_PILLS.map((p) => {
            const active = p.key === interest;
            return (
              <button
                key={p.key}
                type="button"
                onClick={() => setInterest(p.key)}
                className={
                  "rounded-md px-3 py-1 text-sm font-medium transition-colors " +
                  (active
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground")
                }
              >
                {p.label}
              </button>
            );
          })}
        </div>

        <div className="relative max-w-xs flex-1">
          <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search company, reason, list…"
            className="pl-8"
          />
        </div>

        <span className="text-muted-foreground text-sm">
          {filtered.length.toLocaleString()}{" "}
          {filtered.length === 1 ? "call" : "calls"}
        </span>

        <div className="ml-auto">
          <ExportCsvButton
            filename={`${scopeSlug}-voice-of-customer.csv`}
            headers={[
              "day",
              "company",
              "list",
              "interest",
              "reason",
              "theme",
              "suggested_action",
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
                "List",
                "Interest",
                "Reason",
                "Theme",
                "Suggested action",
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
                  colSpan={7}
                  className="text-muted-foreground px-3 py-8 text-center"
                >
                  No calls match these filters.
                </td>
              </tr>
            ) : (
              filtered.map((r) => (
                <tr
                  key={r.id}
                  className="border-border/60 hover:bg-muted/20 border-b align-top"
                >
                  <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                    {r.day}
                  </td>
                  <td className="px-3 py-2 font-medium">{r.company || "—"}</td>
                  <td className="text-muted-foreground px-3 py-2 whitespace-nowrap">
                    {r.list || "—"}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={
                        "rounded-full px-2 py-0.5 text-xs font-medium capitalize " +
                        INTEREST_BADGE[r.interest]
                      }
                    >
                      {r.interest}
                    </span>
                  </td>
                  <td className="text-foreground min-w-[18rem] px-3 py-2 leading-relaxed">
                    {r.reason || (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {readOnly ? (
                      <span className="block min-w-[10rem]">
                        {draft[`${r.id}:theme`] || "—"}
                      </span>
                    ) : (
                      <Textarea
                        value={draft[`${r.id}:theme`] ?? ""}
                        onChange={(e) =>
                          setDraft((d) => ({
                            ...d,
                            [`${r.id}:theme`]: e.target.value,
                          }))
                        }
                        onBlur={() => commit(r.id, "theme")}
                        placeholder="Add a theme…"
                        rows={2}
                        disabled={savingKey === `${r.id}:theme`}
                        className="min-h-0 min-w-[10rem] resize-y text-sm"
                      />
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {readOnly ? (
                      <span className="block min-w-[12rem]">
                        {draft[`${r.id}:suggested_action`] || "—"}
                      </span>
                    ) : (
                      <Textarea
                        value={draft[`${r.id}:suggested_action`] ?? ""}
                        onChange={(e) =>
                          setDraft((d) => ({
                            ...d,
                            [`${r.id}:suggested_action`]: e.target.value,
                          }))
                        }
                        onBlur={() => commit(r.id, "suggested_action")}
                        placeholder="Add a suggested action…"
                        rows={2}
                        disabled={savingKey === `${r.id}:suggested_action`}
                        className="min-h-0 min-w-[12rem] resize-y text-sm"
                      />
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function VoiceStat({
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
        className={`text-[10px] font-medium tracking-[0.14em] uppercase ${tone}`}
      >
        {label}
      </span>
      <span className="text-foreground text-2xl font-medium tabular-nums">
        {value.toLocaleString()}
      </span>
    </div>
  );
}
