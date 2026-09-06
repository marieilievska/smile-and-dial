import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  conversionRate,
  isUnattributed,
  totalsFor,
  workedShare,
  type ListPerformanceRow,
} from "@/lib/analytics/list-performance";
import { costPer } from "@/lib/cohorts/math";
import { formatUsd } from "@/lib/format-usd";

import { ListPeriodToggle } from "./list-period-toggle";

/** The current page URL with the list filter pointed at `listId`, every other
 *  filter preserved. Built here rather than in a client component so the table
 *  stays a Server Component. */
function listHref(baseParams: string, listId: string): string {
  const p = new URLSearchParams(baseParams);
  p.set("list", listId);
  return `/analytics?${p.toString()}`;
}

function count(n: number): string {
  return n.toLocaleString();
}

/** A rate, or an em dash when the denominator makes it meaningless. */
function pct(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

/** Money per outcome, or an em dash. `costPer` already returns null for a zero
 *  denominator, so a list with spend and no sales reads "—" rather than as an
 *  alarming number. */
function money(value: number | null): string {
  return value === null ? "—" : formatUsd(value);
}

/**
 * "Which lead list was worth the money" — every list beside what dialling it
 * produced.
 *
 * The page's campaign and owner filters already apply (the rows are fetched
 * with them), so picking a campaign narrows these numbers to that campaign's
 * calls. The date pills apply only in "This range" mode; the section defaults
 * to All time, because lists are imported at different moments and a
 * thirty-day window makes a list you finished dialling six weeks ago look dead.
 *
 * `leads` is never date-filtered in either mode — the size of a list is a
 * property of the list, not of the window you are looking through.
 */
export function ListPerformanceSection({
  rows,
  period,
  rangeLabel,
  baseParams,
}: {
  rows: readonly ListPerformanceRow[];
  period: "all" | "range";
  rangeLabel: string;
  /** The page's current query string, so a drill-down keeps every filter. */
  baseParams: string;
}) {
  const totals = totalsFor(rows);

  return (
    <section className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both border-border bg-card flex flex-col gap-3 rounded-2xl border p-5 shadow-sm delay-200 duration-500">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-foreground text-sm font-semibold">
            Performance by lead list
          </h2>
          <p className="text-muted-foreground mt-1 text-xs">
            {period === "all"
              ? "Everything each list has produced since it was imported."
              : `Each list's activity in ${rangeLabel}.`}{" "}
            Sorted by goals met.
          </p>
        </div>
        <ListPeriodToggle current={period} />
      </div>

      <div className="border-border overflow-x-auto rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>List</TableHead>
              <TableHead className="text-right">Leads</TableHead>
              <TableHead className="text-right">Worked</TableHead>
              <TableHead className="text-right">Calls</TableHead>
              <TableHead className="text-right">Conn.</TableHead>
              <TableHead className="text-right">DMs</TableHead>
              <TableHead className="text-right">Goals</TableHead>
              <TableHead className="text-right">Conv.</TableHead>
              <TableHead className="text-right">Regs</TableHead>
              <TableHead className="text-right">Att.</TableHead>
              <TableHead className="text-right">Sales</TableHead>
              <TableHead className="text-right">Spend</TableHead>
              <TableHead className="text-right">$/reg</TableHead>
              <TableHead className="text-right">$/sale</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={14}
                  className="text-muted-foreground py-10 text-center text-sm"
                >
                  No lists with activity yet.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => (
                <ListRow
                  key={r.list_id ?? "unattributed"}
                  row={r}
                  baseParams={baseParams}
                />
              ))
            )}
          </TableBody>
          {rows.length > 1 ? (
            <TableFooter>
              <TableRow>
                <TableCell className="font-medium">All lists</TableCell>
                <TableCell className="text-right tabular-nums">
                  {count(totals.leads)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {count(totals.worked)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {count(totals.calls)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {count(totals.connected)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {count(totals.dms)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {count(totals.goals)}
                </TableCell>
                {/* Recomputed from the summed parts, not averaged across rows —
                    an average would weight a 42-lead list like an 84,000-lead
                    one. */}
                <TableCell className="text-right tabular-nums">
                  {pct(
                    totals.worked === 0 ? null : totals.goals / totals.worked,
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {count(totals.regs)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {count(totals.attended)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {count(totals.sales)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatUsd(totals.spend)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {money(costPer(totals.spend, totals.regs))}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {money(costPer(totals.spend, totals.sales))}
                </TableCell>
              </TableRow>
            </TableFooter>
          ) : null}
        </Table>
      </div>

      <p className="text-muted-foreground text-xs">
        <strong>Worked</strong> is the share of the list dialled at least once —
        read every rate beside it, because a list that looks like it converts
        badly is usually a list you have barely started. <strong>Conv.</strong>{" "}
        is goals met as a share of businesses dialled, not of the whole list.
        Goals, DMs and conversions count distinct businesses; calls and spend
        count every call, so <strong>Spend</strong> adds up to the same total as
        the Costs page.
      </p>
    </section>
  );
}

function ListRow({
  row,
  baseParams,
}: {
  row: ListPerformanceRow;
  baseParams: string;
}) {
  const orphan = isUnattributed(row);

  return (
    <TableRow>
      <TableCell className="font-medium">
        {orphan ? (
          <span
            className="text-muted-foreground"
            title="Registrations we could not trace back to a lead, so they belong to no list. Shown so they are never missing from the totals."
          >
            Unattributed
          </span>
        ) : (
          <span className="inline-flex items-center gap-2">
            {/* Drills the whole page into this list — the filter already
                exists, this just points at it. */}
            <Link
              href={listHref(baseParams, row.list_id!)}
              className="hover:text-primary underline-offset-4 hover:underline"
            >
              {row.list_name || "Untitled list"}
            </Link>
            {row.is_inbound ? (
              <Badge variant="secondary" className="text-[10px]">
                Inbound
              </Badge>
            ) : null}
          </span>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {orphan ? "—" : count(row.leads)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {orphan ? "—" : pct(workedShare(row))}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {orphan ? "—" : count(row.calls)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {orphan ? "—" : count(row.connected)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {orphan ? "—" : count(row.dms)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {orphan ? "—" : count(row.goals)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {orphan ? "—" : pct(conversionRate(row))}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {count(row.regs)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {count(row.attended)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {count(row.sales)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {orphan ? "—" : formatUsd(row.spend)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {orphan ? "—" : money(costPer(row.spend, row.regs))}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {orphan ? "—" : money(costPer(row.spend, row.sales))}
      </TableCell>
    </TableRow>
  );
}
