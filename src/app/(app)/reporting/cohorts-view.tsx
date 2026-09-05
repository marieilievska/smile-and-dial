import { AlertTriangle } from "lucide-react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  COHORT_WINDOW_DAYS,
  fetchCohortRows,
  unmarkedSessions,
  type CohortRow,
} from "@/lib/cohorts/data";
import {
  costPer,
  isRipe,
  MIN_CLOSE_SAMPLE,
  MIN_SHOW_SAMPLE,
  projectedCostPerSale,
  rollingRates,
  SALES_WINDOW_DAYS,
} from "@/lib/cohorts/math";
import { ymdLabel } from "@/lib/time/eastern";

/**
 * The "Cohorts" tab: what each day's spend actually bought, however long the
 * answer takes to arrive.
 *
 * The problem it exists to solve: money is spent on the DIAL day, but the
 * people it buys attend a webinar up to a week later and buy after that.
 * Dividing one day's cost by the same day's attendance compares strangers —
 * on 9/3 four people attended, and two of them had been bought on 9/2.
 *
 * So every registration is credited back to the day that paid for it, and a
 * day's row keeps filling in for about a week before it can be judged. The
 * Status column is the load-bearing part: it says whether a row is finished.
 */
export async function CohortsView() {
  const rows = await fetchCohortRows();
  const now = new Date();

  const rates = rollingRates(rows);
  const windowSpend = rows.reduce((n, r) => n + r.spend, 0);
  const windowRegs = rows.reduce((n, r) => n + r.regs, 0);
  const costPerReg = costPer(windowSpend, windowRegs);
  const projected = projectedCostPerSale(
    costPerReg,
    rates.showRate,
    rates.closeRate,
  );
  const forgotten = unmarkedSessions(rows);

  return (
    <div className="flex flex-col gap-5">
      <RatesPanel
        showRate={rates.showRate}
        closeRate={rates.closeRate}
        costPerReg={costPerReg}
        projected={projected}
      />

      {forgotten.length > 0 ? (
        <div className="flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3.5 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div>
            <p className="font-medium">
              {forgotten.length === 1
                ? "One day has registrations but nobody marked attended."
                : `${forgotten.length} days have registrations but nobody marked attended.`}
            </p>
            <p className="text-muted-foreground mt-0.5">
              {forgotten
                .map((f) => `${ymdLabel(f.dial_day)} (${f.regs})`)
                .join(", ")}
              . If that is wrong, mark them on the Goals page — until then they
              count as no-shows and hold the show rate down.
            </p>
          </div>
        </div>
      ) : null}

      <div className="border-border bg-card overflow-x-auto rounded-xl border shadow-sm">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Dial day</TableHead>
              <TableHead className="text-right">Calls</TableHead>
              <TableHead className="text-right">Connected</TableHead>
              <TableHead className="text-right">DMs</TableHead>
              <TableHead className="text-right">Regs</TableHead>
              <TableHead className="text-right">Attended</TableHead>
              <TableHead className="text-right">No-show</TableHead>
              <TableHead className="text-right">Resched.</TableHead>
              <TableHead className="text-right">Sales</TableHead>
              <TableHead className="text-right">Spend</TableHead>
              <TableHead className="text-right">$/reg</TableHead>
              <TableHead className="text-right">$/attended</TableHead>
              <TableHead className="text-right">$/sale</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={14}
                  className="text-muted-foreground py-10 text-center text-sm"
                >
                  No calls in the last {COHORT_WINDOW_DAYS} days yet.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => (
                <CohortTableRow key={r.dial_day} row={r} now={now} />
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <p className="text-muted-foreground text-xs">
        A day is <strong>Final</strong> once every registration it produced has
        had its session and the {SALES_WINDOW_DAYS}-day sales window has closed.
        Until then its ratios are shown in muted italics because they will still
        move — a day with spend and no attendees yet is unfinished, not bad.
      </p>
    </div>
  );
}

function CohortTableRow({ row: r, now }: { row: CohortRow; now: Date }) {
  const ripe = isRipe(r.last_session, r.pending, now);
  const perReg = costPer(r.spend, r.regs);
  const perAttended = costPer(r.spend, r.attended);
  const perSale = costPer(r.spend, r.sales);
  // Unripe ratios stay visible so the day still reads at a glance, but are
  // muted and italic so nobody mistakes a provisional figure for a verdict.
  const ratioClass = ripe
    ? "text-right tabular-nums"
    : "text-muted-foreground text-right tabular-nums italic";

  return (
    <TableRow>
      <TableCell className="font-medium whitespace-nowrap">
        {ymdLabel(r.dial_day)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {r.calls.toLocaleString()}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {r.connected.toLocaleString()}
      </TableCell>
      <TableCell className="text-right tabular-nums">{r.dms}</TableCell>
      <TableCell className="text-right font-medium tabular-nums">
        {r.regs}
      </TableCell>
      <TableCell className="text-right tabular-nums">{r.attended}</TableCell>
      <TableCell className="text-right tabular-nums">{r.no_show}</TableCell>
      <TableCell className="text-right tabular-nums">
        {r.rescheduled || "—"}
      </TableCell>
      <TableCell className="text-right tabular-nums">{r.sales}</TableCell>
      <TableCell className="text-right tabular-nums">
        {money(r.spend)}
      </TableCell>
      <TableCell className={ratioClass}>{money(perReg)}</TableCell>
      <TableCell className={ratioClass}>{money(perAttended)}</TableCell>
      <TableCell className={ratioClass}>{money(perSale)}</TableCell>
      <TableCell className="whitespace-nowrap">
        {ripe ? (
          <span className="text-muted-foreground text-xs">Final</span>
        ) : r.pending > 0 ? (
          <span className="text-xs font-medium text-amber-600 dark:text-amber-400">
            {r.pending} pending
          </span>
        ) : (
          <span className="text-muted-foreground text-xs">Settling</span>
        )}
      </TableCell>
    </TableRow>
  );
}

/** The rolling-rates panel — the numbers that can be steered by TODAY, before
 *  any cohort has ripened. */
function RatesPanel({
  showRate,
  closeRate,
  costPerReg,
  projected,
}: {
  showRate: number | null;
  closeRate: number | null;
  costPerReg: number | null;
  projected: number | null;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Stat
        label={`Show rate (${COHORT_WINDOW_DAYS}d)`}
        value={percent(showRate)}
        hint={
          showRate === null
            ? `Needs ${MIN_SHOW_SAMPLE} finished registrations`
            : "Attended ÷ attended + no-show"
        }
      />
      <Stat
        label={`Close rate (${COHORT_WINDOW_DAYS}d)`}
        value={percent(closeRate)}
        hint={
          closeRate === null
            ? `Needs ${MIN_CLOSE_SAMPLE} attendees`
            : "Sales ÷ attended"
        }
      />
      <Stat
        label="Cost per registration"
        value={money(costPerReg)}
        hint="Knowable the same day — your daily dial"
      />
      <Stat
        label="Projected cost per sale"
        value={money(projected)}
        hint={
          projected === null
            ? "Needs both rates above"
            : "$/reg ÷ show rate ÷ close rate"
        }
      />
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="border-border bg-card rounded-xl border p-3.5 shadow-sm">
      <p className="text-muted-foreground text-xs font-medium">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      <p className="text-muted-foreground mt-0.5 text-[11px]">{hint}</p>
    </div>
  );
}

/** null renders as an em dash, never as $0.00 or $Infinity — "we cannot know
 *  this yet" is a different statement from "this is zero". */
function money(n: number | null): string {
  if (n === null) return "—";
  return `$${n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function percent(n: number | null): string {
  if (n === null) return "—";
  return `${Math.round(n * 100)}%`;
}
