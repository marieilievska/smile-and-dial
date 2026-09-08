import { AlertTriangle, ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { DailyRow, OutcomeBreakdown } from "@/lib/agent-analytics/daily";
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

import { KpiTile } from "../analytics/kpi-tile";
import { DashboardNoteCell } from "./dashboard-note-cell";
import { ExportCsvButton } from "./export-csv-button";

const DASH = "—";

/** null renders as an em dash, never as $0.00 or $Infinity — "we cannot know
 *  this yet" is a different statement from "this is zero". */
function money(n: number | null): string {
  if (n === null) return DASH;
  return `$${n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function percent(n: number | null): string {
  if (n === null) return DASH;
  return `${Math.round(n * 100)}%`;
}

/** Warm % carries a decimal: it moves a point or two a day, and rounding it to
 *  whole percent would flatten the movement it exists to show. */
function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

/** An outcome with no cohort row prints an em dash, never 0 — "nobody
 *  registered" and "we have no row for that day" are different claims. */
function count(n: number | null): string {
  if (n === null) return DASH;
  return n.toLocaleString();
}

/** Shift a YYYY-MM-DD day by `delta` days (UTC-noon math avoids DST edges). */
function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** The selected day when the window holds no row for it — stepping the day
 *  navigator past the edge of the data must show zeros, not crash. */
function zeroRow(day: string): DailyRow {
  return {
    day,
    calls: 0,
    connected: 0,
    conversations: 0,
    dms: 0,
    goals: 0,
    spend: null,
    regs: null,
    attended: null,
    noShow: null,
    rescheduled: null,
    sales: null,
    pending: null,
    lastSession: null,
    costPerReg: null,
    costPerAttended: null,
    breakdown: {
      notInterested: 0,
      gatekeeper: 0,
      gatekeeperDeclined: 0,
      hungUp: 0,
      hungUpLater: 0,
      aiError: 0,
      dnc: 0,
      callbacks: 0,
      warmPct: 0,
    },
  };
}

/** The nine outcome fields that used to be nine columns, as one hover on the
 *  Calls figure they all decompose. Nobody sorted by them and they were why the
 *  table scrolled sideways; the CSV still exports every one. */
function breakdownTitle(b: OutcomeBreakdown, showWarm: boolean): string {
  const lines = [
    `Not interested: ${b.notInterested}`,
    `Gatekeeper: ${b.gatekeeper}`,
    `Gatekeeper declined: ${b.gatekeeperDeclined}`,
    `Hung up: ${b.hungUp}`,
    `Hung up late: ${b.hungUpLater}`,
    `AI error: ${b.aiError}`,
    `DNC: ${b.dnc}`,
    `Callbacks: ${b.callbacks}`,
  ];
  // Warm % only means anything when the scope HAS a sentiment field. Without
  // one every day reads 0.0%, which says "nobody was warm" when the truth is
  // "we never asked" — the same gate the Warm KPI tile uses.
  if (showWarm) lines.push(`Warm: ${pct(b.warmPct)}`);
  return lines.join("\n");
}

/** What the day's attendance is still waiting on. Omitted entirely when there
 *  is no cohort row: no hover beats one reading three zeros. */
function attendedTitle(r: DailyRow): string | undefined {
  if (r.attended === null) return undefined;
  return [
    `No-show: ${r.noShow ?? 0}`,
    `Rescheduled: ${r.rescheduled ?? 0}`,
    `Pending: ${r.pending ?? 0}`,
  ].join("\n");
}

/** Whether a day has stopped changing. One function, so the Status cell and the
 *  CSV cannot disagree about a row. */
function statusLabel(r: DailyRow, now: Date): string | null {
  // No cohort row for the day at all: null, which prints as an em dash. Saying
  // "Settling" would claim we are waiting on sessions we have no record of.
  if (r.pending === null) return null;
  if (isRipe(r.lastSession, r.pending, now)) return "Final";
  if (r.pending > 0) return `${r.pending} pending`;
  return "Settling";
}

/** Days whose registrations all reconciled with nobody marked attended — almost
 *  always a day the operator forgot rather than a session literally nobody
 *  attended. Without surfacing this, forgetting looks identical to a genuine 0%
 *  show rate.
 *
 *  The rule `unmarkedSessions` applied to raw cohort rows, restated on the
 *  joined row: a day with no cohort row has `regs === null`, which is not
 *  `> 0`, so it is excluded rather than counted as forgotten. */
function unmarkedDays(
  rows: readonly DailyRow[],
): { day: string; regs: number }[] {
  return rows
    .filter((r) => (r.regs ?? 0) > 0 && r.attended === 0 && (r.noShow ?? 0) > 0)
    .map((r) => ({ day: r.day, regs: r.noShow ?? 0 }));
}

/**
 * The Reporting hub's Daily tab: one row per dial day, joining what we did that
 * day to what that day produced.
 *
 * Replaces the Dashboard and Cohorts tabs, which were the same rows keyed on
 * the same day — `cohort_rows.dial_day` is stamped from the call that produced
 * the booking — sharing calls, connected and dms across thirty columns and two
 * tabs.
 *
 * Purely presentational: every join and every ratio arrives already computed on
 * `DailyRow` (lib/agent-analytics/daily.ts), so what a number MEANS is decided
 * in a tested module rather than in JSX.
 *
 * `dayHrefFor` enables the day stepper on the authed page; omitted on the
 * public share, which pins to yesterday.
 */
export function DailyView({
  rows,
  day,
  historyDays,
  dayHrefFor,
  notes,
  notesEditable = false,
  scopeSlug = "all-campaigns",
  showMoney = true,
  showActions = true,
  showWarm = false,
  cohortsUnscoped = false,
}: {
  rows: readonly DailyRow[];
  /** The day the KPI cards describe (YYYY-MM-DD, Eastern). */
  day: string;
  /** How many days the table below covers — the label, not a filter. */
  historyDays: number;
  dayHrefFor?: (day: string) => string;
  /** Per-day operator notes (day → text). Provided on both surfaces; read-only
   *  on the share, where `notesEditable` is false. */
  notes?: Record<string, string>;
  notesEditable?: boolean;
  scopeSlug?: string;
  /** False on the public share: spend, cost per registration and cost per
   *  attended are our economics, not a recipient's business. Registrations,
   *  attendance and sales are NOT economics and stay — hiding a whole tab to
   *  hide three money columns is what used to cost management the outcomes. */
  showMoney?: boolean;
  /** False on the public share: the unmarked-sessions warning tells the reader
   *  to go fix something on the Goals page, which an external recipient cannot
   *  open. */
  showActions?: boolean;
  /** True when the scope has a sentiment field, so Warm % is a real measure
   *  rather than 0.0% meaning "we never asked". */
  showWarm?: boolean;
  /** True when the viewer has narrowed to one campaign. `cohort_rows` is not
   *  campaign-scoped, so its outcomes and spend are workspace-wide — pairing
   *  them with this campaign's calls would make every cost-per figure wrong.
   *  Under a campaign scope the outcome and money columns render an em dash
   *  with an explanation rather than a plausible lie. */
  cohortsUnscoped?: boolean;
}) {
  const now = new Date();
  const selected = rows.find((r) => r.day === day) ?? zeroRow(day);

  // Carried over from the Cohorts tab unchanged. The rates panel reads the
  // whole window rather than a row, so it is never paired with one day's calls
  // and survives a campaign scope; only the two cost figures below do not.
  const rates = rollingRates(
    rows.map((r) => ({
      attended: r.attended ?? 0,
      no_show: r.noShow ?? 0,
      sales: r.sales ?? 0,
    })),
  );
  const windowSpend = rows.reduce((n, r) => n + (r.spend ?? 0), 0);
  const windowRegs = rows.reduce((n, r) => n + (r.regs ?? 0), 0);
  const costPerReg = cohortsUnscoped ? null : costPer(windowSpend, windowRegs);
  const projected = cohortsUnscoped
    ? null
    : projectedCostPerSale(costPerReg, rates.showRate, rates.closeRate);
  const forgotten = unmarkedDays(rows);

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-muted-foreground text-sm">
        KPIs for <span className="text-foreground font-medium">{day}</span>{" "}
        (Eastern). History below covers the last {historyDays} days.
      </p>
      {dayHrefFor ? <DayNavigator day={day} hrefFor={dayHrefFor} /> : null}
    </div>
  );

  // An empty window is the ordinary state of a fresh workspace, not an edge
  // case. A header over an empty table reads like a broken page; one sentence
  // reads like an answer.
  if (rows.length === 0) {
    return (
      <div className="flex flex-col gap-5">
        {header}
        <div className="border-border bg-card text-muted-foreground rounded-2xl border p-10 text-center text-sm shadow-sm">
          No calls in the last {historyDays} days yet.
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {header}

      <KpiCards row={selected} showWarm={showWarm} />

      <Trend rows={rows} historyDays={historyDays} />

      <RatesPanel
        windowDays={historyDays}
        showRate={rates.showRate}
        closeRate={rates.closeRate}
        costPerReg={costPerReg}
        projected={projected}
        showMoney={showMoney}
        cohortsUnscoped={cohortsUnscoped}
      />

      {showActions && forgotten.length > 0 ? (
        <UnmarkedWarning days={forgotten} />
      ) : null}

      <section className="border-border bg-card flex flex-col gap-3 rounded-2xl border p-5 shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="text-foreground text-sm font-semibold">
            Daily history
          </h2>
          <ExportCsvButton
            filename={`${scopeSlug}-daily.csv`}
            headers={csvHeaders({ showMoney, showWarm })}
            rows={csvRows(rows, {
              showMoney,
              showWarm,
              cohortsUnscoped,
              notes,
              now,
            })}
          />
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Day</TableHead>
                {NUM_HEADERS.filter(
                  (h) => showMoney || !MONEY_COLUMNS.has(h.label),
                ).map((h) => (
                  <TableHead
                    key={h.label}
                    title={h.title}
                    className="cursor-help text-right"
                  >
                    {h.label}
                  </TableHead>
                ))}
                <TableHead>Status</TableHead>
                <TableHead>Notes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <DailyTableRow
                  key={r.day}
                  row={r}
                  now={now}
                  showMoney={showMoney}
                  showWarm={showWarm}
                  cohortsUnscoped={cohortsUnscoped}
                  note={notes?.[r.day] ?? ""}
                  notesEditable={notesEditable}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      {cohortsUnscoped ? (
        <p className="text-muted-foreground text-xs">
          Registrations, attendance, sales and spend are not yet available per
          campaign: <code>cohort_rows</code> counts the whole workspace, and
          showing those totals beside one campaign&apos;s calls would make every
          cost-per figure wrong. Pick <strong>All campaigns</strong> to see
          them. The call columns are correct as scoped.
        </p>
      ) : (
        <p className="text-muted-foreground text-xs">
          A day is <strong>Final</strong> once every registration it produced
          has had its session and the {SALES_WINDOW_DAYS}-day sales window has
          closed. Until then its ratios are shown in muted italics because they
          will still move — a day with spend and no attendees yet is unfinished,
          not bad.
        </p>
      )}
    </div>
  );
}

function DayNavigator({
  day,
  hrefFor,
}: {
  day: string;
  hrefFor: (day: string) => string;
}) {
  return (
    <div className="border-border bg-card inline-flex items-center gap-1 rounded-lg border p-1 shadow-sm">
      <Link
        href={hrefFor(addDays(day, -1))}
        aria-label="Previous day"
        className="hover:bg-muted/60 text-muted-foreground hover:text-foreground rounded-md p-1.5 transition-colors"
      >
        <ChevronLeft className="size-4" />
      </Link>
      <span className="text-foreground px-2 text-sm font-medium tabular-nums">
        {day}
      </span>
      <Link
        href={hrefFor(addDays(day, 1))}
        aria-label="Next day"
        className="hover:bg-muted/60 text-muted-foreground hover:text-foreground rounded-md p-1.5 transition-colors"
      >
        <ChevronRight className="size-4" />
      </Link>
    </div>
  );
}

/** The selected day at a glance. Activity only — every figure here is scoped by
 *  campaign when the viewer scopes the page, so none of it is touched by the
 *  cohort-scope caveat below the table. */
function KpiCards({ row, showWarm }: { row: DailyRow; showWarm: boolean }) {
  return (
    <section className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">
      <KpiTile label="Calls made" value={row.calls.toLocaleString()} />
      <KpiTile label="Connected" value={row.connected.toLocaleString()} />
      <KpiTile
        label="Conversations >1 min"
        value={row.conversations.toLocaleString()}
        hint="Connected calls only — a long voicemail or phone menu doesn't count"
      />
      <KpiTile
        label="Decision-makers reached"
        value={row.dms.toLocaleString()}
      />
      <KpiTile
        label="Callbacks"
        value={row.breakdown.callbacks.toLocaleString()}
      />
      <KpiTile label="Goals met" value={row.goals.toLocaleString()} />
      {showWarm ? (
        <KpiTile label="Warm %" value={pct(row.breakdown.warmPct)} />
      ) : null}
    </section>
  );
}

/** Calls and goals over the window, so one day reads against its trend. */
function Trend({
  rows,
  historyDays,
}: {
  rows: readonly DailyRow[];
  historyDays: number;
}) {
  const chrono = [...rows].sort((a, b) => a.day.localeCompare(b.day));
  const callsTotal = chrono.reduce((s, r) => s + r.calls, 0);
  const goalsTotal = chrono.reduce((s, r) => s + r.goals, 0);
  return (
    <section className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <MiniSpark
        label={`Calls made · last ${historyDays}d`}
        total={callsTotal.toLocaleString()}
        values={chrono.map((r) => r.calls)}
        color="var(--primary)"
      />
      <MiniSpark
        label={`Goals met · last ${historyDays}d`}
        total={goalsTotal.toLocaleString()}
        values={chrono.map((r) => r.goals)}
        color="var(--success)"
      />
    </section>
  );
}

/** A small server-rendered sparkline (area + line) over the period. */
function MiniSpark({
  label,
  total,
  values,
  color,
}: {
  label: string;
  total: string;
  values: number[];
  color: string;
}) {
  const max = Math.max(1, ...values);
  const n = values.length;
  const pts = values.map((v, i) => {
    const x = n <= 1 ? 0 : (i / (n - 1)) * 100;
    const y = 30 - (v / max) * 28;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const line = pts.join(" ");
  const area = `0,30 ${line} 100,30`;
  return (
    <div className="border-border bg-card flex flex-col gap-2 rounded-xl border p-4 shadow-sm">
      <div className="flex items-baseline justify-between">
        <span className="text-muted-foreground text-[10px] font-medium tracking-[0.14em] uppercase">
          {label}
        </span>
        <span className="text-foreground text-lg font-semibold tabular-nums">
          {total}
        </span>
      </div>
      {n > 1 ? (
        <svg
          viewBox="0 0 100 30"
          preserveAspectRatio="none"
          className="h-10 w-full"
          aria-hidden
        >
          <polygon points={area} fill={color} fillOpacity={0.12} />
          <polyline
            points={line}
            fill="none"
            stroke={color}
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      ) : (
        <div className="text-muted-foreground flex h-10 items-center text-xs">
          Not enough days yet.
        </div>
      )}
    </div>
  );
}

/** The rolling-rates panel — the numbers that can be steered by TODAY, before
 *  any cohort has ripened. The two cost figures are economics and leave the
 *  share; show and close rate are not, and stay. */
function RatesPanel({
  windowDays,
  showRate,
  closeRate,
  costPerReg,
  projected,
  showMoney,
  cohortsUnscoped,
}: {
  windowDays: number;
  showRate: number | null;
  closeRate: number | null;
  costPerReg: number | null;
  projected: number | null;
  showMoney: boolean;
  cohortsUnscoped: boolean;
}) {
  const unavailable = "Not available per campaign — pick All campaigns";
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Stat
        label={`Show rate (${windowDays}d)`}
        value={percent(showRate)}
        hint={
          showRate === null
            ? `Needs ${MIN_SHOW_SAMPLE} finished registrations`
            : "Attended ÷ attended + no-show"
        }
      />
      <Stat
        label={`Close rate (${windowDays}d)`}
        value={percent(closeRate)}
        hint={
          closeRate === null
            ? `Needs ${MIN_CLOSE_SAMPLE} attendees`
            : "Sales ÷ attended"
        }
      />
      {showMoney ? (
        <>
          <Stat
            label="Cost per registration"
            value={money(costPerReg)}
            hint={
              cohortsUnscoped
                ? unavailable
                : "Knowable the same day — your daily dial"
            }
          />
          <Stat
            label="Projected cost per sale"
            value={money(projected)}
            hint={
              cohortsUnscoped
                ? unavailable
                : projected === null
                  ? "Needs both rates above"
                  : "$/reg ÷ show rate ÷ close rate"
            }
          />
        </>
      ) : null}
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

function UnmarkedWarning({ days }: { days: { day: string; regs: number }[] }) {
  return (
    <div className="border-warning/30 bg-warning/5 flex items-start gap-2.5 rounded-xl border p-3.5 text-sm">
      <AlertTriangle className="text-warning mt-0.5 size-4 shrink-0" />
      <div>
        <p className="font-medium">
          {days.length === 1
            ? "One day has registrations but nobody marked attended."
            : `${days.length} days have registrations but nobody marked attended.`}
        </p>
        <p className="text-muted-foreground mt-0.5">
          {days.map((f) => `${ymdLabel(f.day)} (${f.regs})`).join(", ")}. If
          that is wrong, mark them on the Goals page — until then they count as
          no-shows and hold the show rate down.
        </p>
      </div>
    </div>
  );
}

/** The money columns, by header label, so the header list and the row cells
 *  cannot disagree about which three leave the share. */
const MONEY_COLUMNS = new Set(["Spend", "$/reg", "$/att"]);

/** Short labels with a spelled-out `title`, so a fourteen-column table stays
 *  narrow without a manager having to guess what ">1m" means. */
const NUM_HEADERS: { label: string; title: string }[] = [
  {
    label: "Calls",
    title:
      "Calls made (outbound + inbound) — hover a day's number for the outcome breakdown",
  },
  { label: "Conn.", title: "Connected — the call reached a live line" },
  { label: ">1m", title: "Conversations longer than 1 minute" },
  { label: "DMs", title: "Decision-makers reached" },
  { label: "Goals", title: "Goals met — distinct businesses, not calls" },
  {
    label: "Regs",
    title: "Webinar registrations credited back to the day that paid for them",
  },
  {
    label: "Att.",
    title:
      "Attended — hover a day's number for no-show, rescheduled and pending",
  },
  { label: "Sales", title: "Sales credited back to the day that paid" },
  { label: "Spend", title: "What the dialling cost on this day" },
  { label: "$/reg", title: "Spend ÷ registrations" },
  { label: "$/att", title: "Spend ÷ attended" },
];

function DailyTableRow({
  row: r,
  now,
  showMoney,
  showWarm,
  cohortsUnscoped,
  note,
  notesEditable,
}: {
  row: DailyRow;
  now: Date;
  showMoney: boolean;
  showWarm: boolean;
  cohortsUnscoped: boolean;
  note: string;
  notesEditable: boolean;
}) {
  const ripe = isRipe(r.lastSession, r.pending ?? 0, now);
  // Unripe ratios stay visible so the day still reads at a glance, but are
  // muted and italic so nobody mistakes a provisional figure for a verdict.
  const ratioClass = ripe
    ? "text-right tabular-nums"
    : "text-muted-foreground text-right tabular-nums italic";
  // Under a campaign scope every cohort-derived cell describes the whole
  // workspace, so the right-hand side of the row goes to em dashes — Status
  // included, because "3 pending" is a count from that same unscoped source.
  const settling = !cohortsUnscoped && !ripe && (r.pending ?? 0) > 0;

  return (
    <TableRow>
      <TableCell className="font-medium whitespace-nowrap">{r.day}</TableCell>
      <TableCell
        title={breakdownTitle(r.breakdown, showWarm)}
        className="cursor-help text-right tabular-nums"
      >
        {r.calls.toLocaleString()}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {r.connected.toLocaleString()}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {r.conversations.toLocaleString()}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {r.dms.toLocaleString()}
      </TableCell>
      <TableCell className="text-foreground text-right font-medium tabular-nums">
        {r.goals.toLocaleString()}
      </TableCell>
      <TableCell className="text-right font-medium tabular-nums">
        {cohortsUnscoped ? DASH : count(r.regs)}
      </TableCell>
      <TableCell
        title={cohortsUnscoped ? undefined : attendedTitle(r)}
        className={
          cohortsUnscoped || r.attended === null
            ? "text-right tabular-nums"
            : "cursor-help text-right tabular-nums"
        }
      >
        {cohortsUnscoped ? DASH : count(r.attended)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {cohortsUnscoped ? DASH : count(r.sales)}
      </TableCell>
      {showMoney ? (
        <>
          <TableCell className="text-right tabular-nums">
            {cohortsUnscoped ? DASH : money(r.spend)}
          </TableCell>
          <TableCell className={ratioClass}>
            {cohortsUnscoped ? DASH : money(r.costPerReg)}
          </TableCell>
          <TableCell className={ratioClass}>
            {cohortsUnscoped ? DASH : money(r.costPerAttended)}
          </TableCell>
        </>
      ) : null}
      <TableCell className="whitespace-nowrap">
        {settling ? (
          <span className="text-warning text-xs font-medium">
            {statusLabel(r, now)}
          </span>
        ) : (
          <span className="text-muted-foreground text-xs">
            {(cohortsUnscoped ? null : statusLabel(r, now)) ?? DASH}
          </span>
        )}
      </TableCell>
      <TableCell>
        {notesEditable ? (
          <DashboardNoteCell day={r.day} initial={note} />
        ) : (
          <span className="text-muted-foreground text-xs">{note}</span>
        )}
      </TableCell>
    </TableRow>
  );
}

/** The CSV keeps every field, including the nine folded behind the Calls hover
 *  — that is what makes folding them safe. Money leaves the share here too, and
 *  a campaign-scoped export writes the cohort fields blank rather than putting
 *  a workspace-wide number under a campaign's name. */
function csvHeaders({
  showMoney,
  showWarm,
}: {
  showMoney: boolean;
  showWarm: boolean;
}): string[] {
  return [
    "day",
    "calls_made",
    "connected",
    "conversations_gt1min",
    "dms_reached",
    "goals_met",
    "not_interested",
    "gatekeeper",
    "gatekeeper_declined",
    "hung_up",
    "hung_up_later",
    "ai_error",
    "dnc",
    "callbacks",
    ...(showWarm ? ["warm_pct"] : []),
    "regs",
    "attended",
    "no_show",
    "rescheduled",
    "sales",
    "pending",
    ...(showMoney ? ["spend", "cost_per_reg", "cost_per_attended"] : []),
    "last_session",
    "status",
    "note",
  ];
}

function csvRows(
  rows: readonly DailyRow[],
  {
    showMoney,
    showWarm,
    cohortsUnscoped,
    notes,
    now,
  }: {
    showMoney: boolean;
    showWarm: boolean;
    cohortsUnscoped: boolean;
    notes?: Record<string, string>;
    now: Date;
  },
): (string | number | null)[][] {
  // A blank cell, not a zero — the same em-dash rule the table follows.
  const cohort = <T,>(v: T | null): T | null => (cohortsUnscoped ? null : v);
  return rows.map((r) => [
    r.day,
    r.calls,
    r.connected,
    r.conversations,
    r.dms,
    r.goals,
    r.breakdown.notInterested,
    r.breakdown.gatekeeper,
    r.breakdown.gatekeeperDeclined,
    r.breakdown.hungUp,
    r.breakdown.hungUpLater,
    r.breakdown.aiError,
    r.breakdown.dnc,
    r.breakdown.callbacks,
    ...(showWarm ? [pct(r.breakdown.warmPct)] : []),
    cohort(r.regs),
    cohort(r.attended),
    cohort(r.noShow),
    cohort(r.rescheduled),
    cohort(r.sales),
    cohort(r.pending),
    ...(showMoney
      ? [cohort(r.spend), cohort(r.costPerReg), cohort(r.costPerAttended)]
      : []),
    cohort(r.lastSession),
    cohort(statusLabel(r, now)),
    notes?.[r.day] ?? "",
  ]);
}
