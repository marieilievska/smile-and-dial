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
  costPerAttended,
  daysLeft,
  projectionConfidence,
  settledCount,
  type EconomicsTotals,
} from "@/lib/analytics/list-economics";
import {
  conversionRate,
  isUnattributed,
  reachedShare,
  totalsFor,
  voicemailShare,
  workedShare,
  type ListPerformanceRow,
} from "@/lib/analytics/list-performance";
import { costPer, MIN_SHOW_SAMPLE } from "@/lib/cohorts/math";
import { formatUsd } from "@/lib/format-usd";

import { ListPeriodToggle } from "./list-period-toggle";

/** How many columns the empty state has to span. Named so that adding a column
 *  and forgetting the colSpan cannot leave a lopsided "no lists yet" row. */
const COLUMNS = 13;

/**
 * Everything the money and inventory cells read.
 *
 * Satisfied by BOTH one `ListPerformanceRow` and the object `totalsFor(...)`
 * returns — which is the point. `$/att` and `Remaining` are rendered by the
 * same two components in a row and in the footer, so those two totals can only
 * ever be the row arithmetic applied to summed parts. There is no second
 * implementation for them to drift from.
 */
type Economics = EconomicsTotals &
  Pick<
    ListPerformanceRow,
    "line_typed" | "mobiles" | "bad_number" | "suppressed" | "resting"
  >;

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
 *  denominator — and, in this app, for zero SPEND too, because no cost rows
 *  landed does not mean the calls were free. */
function money(value: number | null): string {
  return value === null ? "—" : formatUsd(value);
}

/** "1 mobile" / "0 mobiles", for the hover breakdown. */
function plural(n: number, one: string, many: string): string {
  return `${count(n)} ${n === 1 ? one : many}`;
}

/**
 * What `Remaining` is leaving out, in one line of plain English.
 *
 * Mobiles, Bad no., Suppressed and Resting used to be four columns of their
 * own; on production they read —, 0, 36 and 400. That is real page width for
 * four near-zero counts nobody sorts by, and they only ever meant anything
 * beside the number they explain. So they moved into it.
 *
 * The em-dash rule moves with them. `line_typed` at zero means no phone-line
 * lookup has ever run on this workspace, so "0 mobiles" would be a claim we
 * have not earned — "never checked" is a reason to go and check. The two must
 * not read the same.
 */
function remainingTitle(t: Economics): string {
  const held = [
    t.line_typed > 0
      ? plural(t.mobiles, "mobile", "mobiles")
      : "mobiles never checked",
    plural(t.bad_number, "bad number", "bad numbers"),
    `${count(t.suppressed)} suppressed`,
    `${count(t.resting)} resting`,
  ].join(" · ");
  return `Still workable: has a number, not suppressed, not a mobile, not finished. Held back: ${held}.`;
}

/**
 * "Which lead list was worth the money, and is it still worth dialling" — one
 * table, because that was always one question.
 *
 * This section used to be two, stacked: fourteen columns of performance, then
 * ten of reachability, sharing three of them and scrolling twenty-four columns
 * sideways to show two rows of data. The funnel panel above now carries the
 * chain — calls, connects, decision-makers, goals, sales — with conversion and
 * cost at every step, which is what those count columns were reaching for and
 * could not show. What is left here is the part a funnel cannot answer: how
 * these lists DIFFER from one another.
 *
 * The page's campaign and owner filters already apply (the rows are fetched
 * with them), so picking a campaign narrows these numbers to that campaign's
 * calls. The date pills apply only in "This range" mode; the section defaults
 * to All time, because lists are imported at different moments and a
 * thirty-day window makes a list you finished dialling six weeks ago look dead.
 *
 * `leads`, `remaining` and the pace behind `Days left` are never date-filtered
 * in either mode — the size of a list, and what is left in it, are properties
 * of the list, not of the window you are looking through.
 */
export function ListEconomicsTable({
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
  // Over every row INCLUDING the unattributed one, exactly like the funnel
  // panel above, which is fed totalsFor(listRows) from the same array. Its
  // registrations are real and its activity columns are all zero, so keeping
  // it costs the rates nothing and keeps the two panels reconciled.
  const totals = totalsFor(rows);

  return (
    <section className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both border-border bg-card flex flex-col gap-3 rounded-2xl border p-5 shadow-sm delay-250 duration-500">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-foreground text-sm font-semibold">
            Performance by lead list
          </h2>
          <p className="text-muted-foreground mt-1 text-xs">
            {period === "all"
              ? "Everything each list has produced since it was imported."
              : `Each list's activity in ${rangeLabel}.`}{" "}
            Sorted by goals met. Leads, Remaining and Days left ignore the
            period — how big a list is, and what is left in it, are counted as
            they stand now.
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
              <TableHead className="text-right">Reached</TableHead>
              <TableHead className="text-right">VM</TableHead>
              <TableHead className="text-right">Conv.</TableHead>
              <TableHead className="text-right">Regs</TableHead>
              <TableHead className="text-right">Att.</TableHead>
              <TableHead className="text-right">Spend</TableHead>
              <TableHead className="text-right">$/reg</TableHead>
              <TableHead className="text-right">$/att</TableHead>
              <TableHead className="text-right">Remaining</TableHead>
              <TableHead className="text-right">Days left</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={COLUMNS}
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
          {rows.length > 1 ? <TotalsRow totals={totals} /> : null}
        </Table>
      </div>

      <p className="text-muted-foreground text-xs">
        <strong>Worked</strong> is the share of the list dialled at least once —
        read every rate beside it, because a list that looks like it converts
        badly is usually a list you have barely started. <strong>Conv.</strong>{" "}
        is goals met as a share of businesses <em>dialled</em>, not of the whole
        list. <strong>VM</strong> is the one rate here counted over calls rather
        than over businesses. <strong>$/att</strong> is projected — cost per
        registration divided by the settled show rate — and stays dimmed,
        carrying the sample it was built on, until {MIN_SHOW_SAMPLE}{" "}
        registrations have settled. <strong>Remaining</strong> is what is still
        workable; hover it for what is being held back. It is deliberately{" "}
        <em>not</em> the dial queue, which is gated on calling hours and reads
        zero overnight. <strong>Days left</strong> divides that by the last
        week&apos;s pace, so it is an em dash for a list nothing has been
        dialled from this week. <strong>Spend</strong> adds up to the same total
        as the Costs page.
      </p>
    </section>
  );
}

/** One lead list. */
function ListRow({
  row,
  baseParams,
}: {
  row: ListPerformanceRow;
  baseParams: string;
}) {
  // The unattributed row carries registrations that could not be traced back
  // to a lead. It has no list, so it has no size, no dialling, no spend and
  // nothing left to work — only Regs and Att. are real on it, and every other
  // cell is an em dash rather than a zero that would read as a finding.
  if (isUnattributed(row)) {
    return (
      <TableRow>
        <TableCell className="font-medium">
          <span
            className="text-muted-foreground"
            title="Registrations we could not trace back to a lead, so they belong to no list. Shown so they are never missing from the totals."
          >
            Unattributed
          </span>
        </TableCell>
        <Dash />
        <Dash />
        <Dash />
        <Dash />
        <Dash />
        <TableCell className="text-right tabular-nums">
          {count(row.regs)}
        </TableCell>
        <TableCell className="text-right tabular-nums">
          {count(row.attended)}
        </TableCell>
        <Dash />
        <Dash />
        <Dash />
        <Dash />
        <Dash />
      </TableRow>
    );
  }

  return (
    <TableRow>
      <TableCell className="font-medium">
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
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {count(row.leads)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {pct(workedShare(row))}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {pct(reachedShare(row))}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {pct(voicemailShare(row))}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {pct(conversionRate(row))}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {count(row.regs)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {count(row.attended)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {formatUsd(row.spend)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {money(costPer(row.spend, row.regs))}
      </TableCell>
      <CostPerAttendedCell t={row} />
      <RemainingCell t={row} />
      <TableCell className="text-right tabular-nums">
        {/* first_dial, never first_call. The two are one character apart and
            mean different things — see the precondition on daysLeft. */}
        {daysLeft(row, row.first_dial) ?? "—"}
      </TableCell>
    </TableRow>
  );
}

/**
 * The bottom line.
 *
 * Every rate is recomputed from the SUMMED parts, never averaged across the
 * rows above — an average would weight a 42-lead list the same as an
 * 84,000-lead one, which on this workspace is the difference between a 9%
 * worked share and a 54% one. `$/att` and `Remaining` go through the same two
 * components a row uses, so those two cannot be recomputed differently here by
 * accident.
 */
function TotalsRow({ totals }: { totals: Economics }) {
  return (
    <TableFooter>
      <TableRow>
        <TableCell className="font-medium">All lists</TableCell>
        <TableCell className="text-right tabular-nums">
          {count(totals.leads)}
        </TableCell>
        <TableCell className="text-right tabular-nums">
          {pct(totals.leads === 0 ? null : totals.worked / totals.leads)}
        </TableCell>
        <TableCell className="text-right tabular-nums">
          {pct(totals.worked === 0 ? null : totals.reached / totals.worked)}
        </TableCell>
        <TableCell className="text-right tabular-nums">
          {pct(totals.calls === 0 ? null : totals.voicemail / totals.calls)}
        </TableCell>
        <TableCell className="text-right tabular-nums">
          {pct(totals.worked === 0 ? null : totals.goals / totals.worked)}
        </TableCell>
        <TableCell className="text-right tabular-nums">
          {count(totals.regs)}
        </TableCell>
        <TableCell className="text-right tabular-nums">
          {count(totals.attended)}
        </TableCell>
        <TableCell className="text-right tabular-nums">
          {formatUsd(totals.spend)}
        </TableCell>
        <TableCell className="text-right tabular-nums">
          {money(costPer(totals.spend, totals.regs))}
        </TableCell>
        <CostPerAttendedCell t={totals} />
        <RemainingCell t={totals} />
        <TableCell
          className="text-muted-foreground text-right tabular-nums"
          title="Not summable. A list you have barely started and one you have nearly finished do not share a finish line, so a combined pace would be a number about neither."
        >
          —
        </TableCell>
      </TableRow>
    </TableFooter>
  );
}

/**
 * What an attendee costs, weighted by how much the reader should trust it.
 *
 * The same treatment the funnel panel gives its cost column, for the same
 * reason: a projection is only dangerous when its sample is invisible. Below
 * three settled registrations there is no number at all; below ten there is
 * one, but dimmed and carrying the sample it was built on.
 */
function CostPerAttendedCell({ t }: { t: Economics }) {
  const settled = settledCount(t);
  const confidence = projectionConfidence(settled);

  if (confidence === "hidden") {
    return (
      <TableCell className="text-muted-foreground text-right tabular-nums">
        —
      </TableCell>
    );
  }

  const value = costPerAttended(t);
  const low = confidence === "low";

  return (
    <TableCell className="text-right tabular-nums">
      <span className="flex flex-col items-end gap-0.5">
        <span className={low ? "text-muted-foreground" : undefined}>
          {money(value)}
        </span>
        {/* A caveat under an em dash qualifies nothing, so the sample line
            only appears when there is a number for it to qualify. */}
        {low && value !== null ? (
          <span className="text-muted-foreground text-[11px]">
            from {count(settled)}
          </span>
        ) : null}
      </span>
    </TableCell>
  );
}

/** What is still workable, with what is being held out of it on the hover. */
function RemainingCell({ t }: { t: Economics }) {
  return (
    <TableCell
      className="text-right font-medium tabular-nums"
      title={remainingTitle(t)}
    >
      {count(t.remaining)}
    </TableCell>
  );
}

/** A cell with nothing true to put in it. */
function Dash() {
  return <TableCell className="text-right tabular-nums">—</TableCell>;
}
