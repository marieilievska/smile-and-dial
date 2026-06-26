"use client";

import { useMemo, useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { dismissHotLead } from "@/lib/agent-analytics/actions";
import type { HotLeadRow } from "@/lib/agent-analytics/report-data";

import { ExportCsvButton } from "./export-csv-button";

export type { HotLeadRow };

/** Hot Leads — the selected campaign's warm calls (positive/neutral sentiment),
 *  newest first. Admins can open the lead and delete a row (permanent hide).
 *  `readOnly` (public share) drops the lead link + delete. */
export function HotLeadsTable({
  rows,
  readOnly = false,
  scopeSlug = "all-campaigns",
}: {
  rows: HotLeadRow[];
  readOnly?: boolean;
  scopeSlug?: string;
}) {
  const [q, setQ] = useState("");
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [, startTransition] = useTransition();

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (removed.has(r.id)) return false;
      if (!needle) return true;
      return (
        r.company.toLowerCase().includes(needle) ||
        r.contact.toLowerCase().includes(needle) ||
        r.whyHot.toLowerCase().includes(needle)
      );
    });
  }, [rows, q, removed]);

  function remove(id: string) {
    if (!window.confirm("Remove this lead from Hot Leads?")) return;
    setRemoved((s) => new Set(s).add(id)); // optimistic
    startTransition(async () => {
      const res = await dismissHotLead({ callId: id });
      if (res.error) {
        toast.error(res.error);
        setRemoved((s) => {
          const n = new Set(s);
          n.delete(id);
          return n;
        });
        return;
      }
      toast.success("Removed");
    });
  }

  const exportRows = filtered.map((r) => [
    r.day,
    r.company,
    r.contact,
    r.whyHot,
    r.list,
  ]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-muted-foreground text-sm">
          Warm leads from the last 30 days (yes / maybe). Work them, then remove
          the ones you&apos;ve handled.
        </p>
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search company, contact, why hot…"
          className="ml-auto h-8 w-[16rem]"
        />
        <ExportCsvButton
          filename={`${scopeSlug}-hot-leads.csv`}
          headers={["day", "company", "contact", "why_hot", "list"]}
          rows={exportRows}
        />
      </div>

      {filtered.length === 0 ? (
        <div className="border-border text-muted-foreground rounded-2xl border border-dashed px-6 py-12 text-center text-sm">
          No hot leads.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-muted-foreground bg-muted/30 text-left text-[10px] tracking-wide uppercase">
                <th className="rounded-l-md px-3 py-2 font-medium whitespace-nowrap">
                  Date
                </th>
                <th className="px-3 py-2 font-medium">Company</th>
                <th className="px-3 py-2 font-medium whitespace-nowrap">
                  Contact
                </th>
                <th className="px-3 py-2 font-medium">Why hot</th>
                <th className="px-3 py-2 font-medium whitespace-nowrap">
                  List
                </th>
                {!readOnly ? (
                  <th className="rounded-r-md px-3 py-2 font-medium whitespace-nowrap">
                    <span className="sr-only">Remove</span>
                  </th>
                ) : null}
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
                    {r.contact || "—"}
                  </td>
                  <td className="text-muted-foreground px-3 py-2">
                    {r.whyHot || "—"}
                  </td>
                  <td className="text-muted-foreground px-3 py-2 whitespace-nowrap">
                    {r.list || "—"}
                  </td>
                  {!readOnly ? (
                    <td className="px-3 py-2 whitespace-nowrap">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => remove(r.id)}
                        aria-label="Remove from Hot Leads"
                        className="text-muted-foreground hover:text-destructive size-8"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
