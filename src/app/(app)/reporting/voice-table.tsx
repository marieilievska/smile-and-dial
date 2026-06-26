"use client";

import { useMemo, useState } from "react";
import { Play } from "lucide-react";
import Link from "next/link";

import { Input } from "@/components/ui/input";
import { sentimentTone } from "@/lib/agent-analytics/field-detect";
import type { VoiceRow } from "@/lib/agent-analytics/report-data";

import { ExportCsvButton } from "./export-csv-button";

export type { VoiceRow };

/** "yes" → "Yes", "lead source" stays per-word capitalized. */
function titleCase(v: string): string {
  return v.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Voice of Customer — one row per call that recorded the campaign's sentiment
 *  answer (last 30d), with the free-text notes, the lead, and an inline
 *  recording player. `readOnly` (public share) makes the company plain text.
 *  `recordingSrcFor` builds the `<audio src>` URL for a call id. */
export function VoiceTable({
  rows,
  sentimentValues,
  recordingSrcFor,
  readOnly = false,
  scopeSlug = "all-campaigns",
}: {
  rows: VoiceRow[];
  sentimentValues: string[];
  recordingSrcFor: (callId: string) => string;
  readOnly?: boolean;
  scopeSlug?: string;
}) {
  const [filter, setFilter] = useState<string>("all");
  const [q, setQ] = useState("");
  const [playing, setPlaying] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter !== "all" && r.sentiment !== filter) return false;
      if (!needle) return true;
      return (
        r.company.toLowerCase().includes(needle) ||
        r.notes.toLowerCase().includes(needle) ||
        r.list.toLowerCase().includes(needle)
      );
    });
  }, [rows, filter, q]);

  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of rows) m[r.sentiment] = (m[r.sentiment] ?? 0) + 1;
    return m;
  }, [rows]);

  const exportRows = filtered.map((r) => [
    r.day,
    r.company,
    r.list,
    r.sentiment,
    r.notes,
  ]);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground text-sm">
        Every call with a customer-sentiment answer (last 30 days), with the
        agent&apos;s recorded notes and the call recording.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <FilterPill
          label="All"
          active={filter === "all"}
          onClick={() => setFilter("all")}
          count={rows.length}
        />
        {sentimentValues.map((v) => (
          <FilterPill
            key={v}
            label={titleCase(v)}
            active={filter === v}
            onClick={() => setFilter(v)}
            count={counts[v] ?? 0}
          />
        ))}
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search company, notes, list…"
          className="ml-auto h-8 w-[16rem]"
        />
        <ExportCsvButton
          filename={`${scopeSlug}-voice-of-customer.csv`}
          headers={["day", "company", "list", "sentiment", "notes"]}
          rows={exportRows}
        />
      </div>

      {filtered.length === 0 ? (
        <div className="border-border text-muted-foreground rounded-2xl border border-dashed px-6 py-12 text-center text-sm">
          No matching calls.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-muted-foreground bg-muted/30 text-left text-[10px] tracking-wide uppercase">
                <th className="rounded-l-md px-3 py-2 font-medium whitespace-nowrap">
                  Day
                </th>
                <th className="px-3 py-2 font-medium">Company</th>
                <th className="px-3 py-2 font-medium whitespace-nowrap">
                  List
                </th>
                <th className="px-3 py-2 font-medium whitespace-nowrap">
                  Sentiment
                </th>
                <th className="px-3 py-2 font-medium">Notes</th>
                <th className="rounded-r-md px-3 py-2 font-medium whitespace-nowrap">
                  Recording
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr
                  key={r.id}
                  className="border-border/60 hover:bg-muted/30 border-b align-top transition-colors"
                >
                  <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                    {r.day}
                  </td>
                  <td className="text-foreground px-3 py-2 font-medium">
                    {!readOnly && r.leadId ? (
                      <Link
                        href={`/leads/${r.leadId}`}
                        className="hover:text-primary hover:underline"
                      >
                        {r.company || "—"}
                      </Link>
                    ) : (
                      r.company || "—"
                    )}
                  </td>
                  <td className="text-muted-foreground px-3 py-2 whitespace-nowrap">
                    {r.list || "—"}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${sentimentTone(r.sentiment)}`}
                    >
                      {titleCase(r.sentiment)}
                    </span>
                  </td>
                  <td className="text-muted-foreground px-3 py-2">
                    {r.notes || "—"}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {r.recordingPath ? (
                      playing === r.id ? (
                        <audio
                          controls
                          autoPlay
                          preload="none"
                          src={recordingSrcFor(r.id)}
                          className="h-8 w-[14rem]"
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={() => setPlaying(r.id)}
                          className="text-primary inline-flex items-center gap-1 hover:underline"
                        >
                          <Play className="size-3.5" /> Play
                        </button>
                      )
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

function FilterPill({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "rounded-full px-3 py-1 text-xs font-medium transition-colors " +
        (active
          ? "bg-foreground text-background"
          : "bg-muted text-muted-foreground hover:text-foreground")
      }
    >
      {label} <span className="tabular-nums opacity-70">{count}</span>
    </button>
  );
}
