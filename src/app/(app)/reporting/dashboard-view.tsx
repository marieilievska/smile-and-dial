import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";

import { type DailyKpi } from "@/lib/agent-analytics/stats";

import { KpiTile } from "../analytics/kpi-tile";
import { DashboardNoteCell } from "./dashboard-note-cell";
import { ExportCsvButton } from "./export-csv-button";

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

/** "lead source satisfaction" / "happy" → "Happy" for a column header. */
function titleCase(v: string): string {
  return v.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Tailwind classes for the Warm % chip, color-coded by health. */
function warmChip(v: number) {
  const cls =
    v >= 0.5
      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
      : v >= 0.3
        ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
        : "bg-rose-500/15 text-rose-600 dark:text-rose-400";
  return (
    <span
      className={`inline-block rounded-md px-2 py-0.5 text-xs font-medium tabular-nums ${cls}`}
    >
      {pct(v)}
    </span>
  );
}

/** Shift a YYYY-MM-DD day by `delta` days (UTC-noon math avoids DST edges). */
function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function zeroDay(day: string): DailyKpi {
  return {
    day,
    callsMade: 0,
    connected: 0,
    convGt1min: 0,
    dms: 0,
    callbacks: 0,
    callbackLater: 0,
    goals: 0,
    notInterested: 0,
    gatekeeper: 0,
    hungUp: 0,
    aiError: 0,
    dnc: 0,
    sentimentCounts: {},
    warmPct: 0,
  };
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

/** Presentational Dashboard: KPI cards for the selected day + period trend
 *  sparklines + a daily history table + CSV export. Aggregate counts only —
 *  no per-call PII — so it's safe on both the admin page and the public share.
 *
 *  `dayHrefFor` enables the day stepper on the authed page; omitted on the
 *  public share (which pins to yesterday). */
export function DashboardView({
  kpis,
  day,
  historyDays,
  dayHrefFor,
  notes,
  notesEditable = false,
  scopeSlug = "all-agents",
  sentimentValues = [],
}: {
  kpis: DailyKpi[];
  day: string;
  historyDays: number;
  dayHrefFor?: (day: string) => string;
  /** Per-day operator notes (day → text), shown in the history table. Provided
   *  on the authed page and the public share. */
  notes?: Record<string, string>;
  /** When true the note cell is an inline editor (logged-in admin); otherwise
   *  it renders read-only text (anonymous share viewers). */
  notesEditable?: boolean;
  scopeSlug?: string;
  /** The selected campaign's sentiment values, in display order. Empty = no
   *  sentiment columns (combined view or a campaign without sentiment). */
  sentimentValues?: string[];
}) {
  const showSentiment = sentimentValues.length > 0;
  const showNotes = notes !== undefined;
  const sel = kpis.find((k) => k.day === day) ?? zeroDay(day);
  const chrono = [...kpis].sort((a, b) => a.day.localeCompare(b.day));
  const callsTotal = chrono.reduce((s, k) => s + k.callsMade, 0);
  const goalsTotal = chrono.reduce((s, k) => s + k.goals, 0);

  const exportRows = kpis.map((k) => [
    k.day,
    k.callsMade,
    k.connected,
    k.convGt1min,
    k.dms,
    k.callbacks,
    k.callbackLater,
    k.goals,
    k.notInterested,
    k.gatekeeper,
    k.hungUp,
    k.aiError,
    k.dnc,
    ...sentimentValues.map((v) => k.sentimentCounts[v] ?? 0),
    ...(showSentiment ? [pct(k.warmPct)] : []),
  ]);

  const NUM_HEADERS = [
    "Calls",
    "Conn.",
    ">1m",
    "DMs",
    "CB",
    "CB later",
    "Goals",
    "Not int.",
    "Gatekpr",
    "Hung up",
    "AI err",
    "DNC",
    ...sentimentValues.map(titleCase),
  ];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm">
          KPIs for <span className="text-foreground font-medium">{day}</span>{" "}
          (Eastern). History below covers the last {historyDays} days.
        </p>
        {dayHrefFor ? (
          <div className="border-border bg-card inline-flex items-center gap-1 rounded-lg border p-1 shadow-sm">
            <Link
              href={dayHrefFor(addDays(day, -1))}
              aria-label="Previous day"
              className="hover:bg-muted/60 text-muted-foreground hover:text-foreground rounded-md p-1.5 transition-colors"
            >
              <ChevronLeft className="size-4" />
            </Link>
            <span className="text-foreground px-2 text-sm font-medium tabular-nums">
              {day}
            </span>
            <Link
              href={dayHrefFor(addDays(day, 1))}
              aria-label="Next day"
              className="hover:bg-muted/60 text-muted-foreground hover:text-foreground rounded-md p-1.5 transition-colors"
            >
              <ChevronRight className="size-4" />
            </Link>
          </div>
        ) : null}
      </div>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">
        <KpiTile label="Calls made" value={sel.callsMade.toLocaleString()} />
        <KpiTile label="Connected" value={sel.connected.toLocaleString()} />
        <KpiTile
          label="Conversations >1 min"
          value={sel.convGt1min.toLocaleString()}
        />
        <KpiTile label="DMs reached" value={sel.dms.toLocaleString()} />
        <KpiTile label="Callbacks" value={sel.callbacks.toLocaleString()} />
        <KpiTile label="Goals met" value={sel.goals.toLocaleString()} />
        {showSentiment ? (
          <KpiTile label="Warm %" value={pct(sel.warmPct)} />
        ) : null}
      </section>

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <MiniSpark
          label={`Calls made · last ${historyDays}d`}
          total={callsTotal.toLocaleString()}
          values={chrono.map((k) => k.callsMade)}
          color="var(--primary)"
        />
        <MiniSpark
          label={`Goals met · last ${historyDays}d`}
          total={goalsTotal.toLocaleString()}
          values={chrono.map((k) => k.goals)}
          color="var(--success)"
        />
      </section>

      <section className="border-border bg-card flex flex-col gap-3 rounded-2xl border p-5 shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="text-foreground text-sm font-semibold">
            Daily history
          </h2>
          <ExportCsvButton
            filename={`${scopeSlug}-kpis.csv`}
            headers={[
              "day",
              "calls_made",
              "connected",
              "conversations_gt1min",
              "dms_reached",
              "callbacks",
              "callback_later",
              "goals_met",
              "not_interested",
              "gatekeeper",
              "hung_up",
              "ai_error",
              "dnc",
              ...sentimentValues,
              ...(showSentiment ? ["warm_pct"] : []),
            ]}
            rows={exportRows}
          />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-muted-foreground bg-muted/30 text-left text-[10px] tracking-wide uppercase">
                <th className="rounded-l-md px-3 py-2 font-medium whitespace-nowrap">
                  Day
                </th>
                {NUM_HEADERS.map((h, i) => {
                  const isLast =
                    i === NUM_HEADERS.length - 1 &&
                    !showSentiment &&
                    !showNotes;
                  return (
                    <th
                      key={h}
                      className={`px-3 py-2 text-right font-medium whitespace-nowrap ${isLast ? "rounded-r-md" : ""}`}
                    >
                      {h}
                    </th>
                  );
                })}
                {showSentiment ? (
                  <th
                    className={`px-3 py-2 text-right font-medium whitespace-nowrap ${showNotes ? "" : "rounded-r-md"}`}
                  >
                    Warm %
                  </th>
                ) : null}
                {showNotes ? (
                  <th className="rounded-r-md px-3 py-2 text-left font-medium whitespace-nowrap">
                    Notes
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {kpis.length === 0 ? (
                <tr>
                  <td
                    colSpan={
                      1 +
                      NUM_HEADERS.length +
                      (showSentiment ? 1 : 0) +
                      (showNotes ? 1 : 0)
                    }
                    className="text-muted-foreground px-3 py-6 text-center"
                  >
                    No calls in the last {historyDays} days.
                  </td>
                </tr>
              ) : (
                kpis.map((k) => (
                  <tr
                    key={k.day}
                    className="border-border/60 hover:bg-muted/30 border-b transition-colors"
                  >
                    <td className="px-3 py-2 font-medium whitespace-nowrap">
                      {k.day}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {k.callsMade}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {k.connected}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {k.convGt1min}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {k.dms}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {k.callbacks}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {k.callbackLater}
                    </td>
                    <td className="text-foreground px-3 py-2 text-right font-medium tabular-nums">
                      {k.goals}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {k.notInterested}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {k.gatekeeper}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {k.hungUp}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {k.aiError}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {k.dnc}
                    </td>
                    {showSentiment ? (
                      <>
                        {sentimentValues.map((v) => (
                          <td
                            key={v}
                            className="px-3 py-2 text-right tabular-nums"
                          >
                            {k.sentimentCounts[v] ?? 0}
                          </td>
                        ))}
                        <td className="px-3 py-2 text-right">
                          {warmChip(k.warmPct)}
                        </td>
                      </>
                    ) : null}
                    {showNotes ? (
                      <td className="px-3 py-2">
                        {notesEditable ? (
                          <DashboardNoteCell
                            day={k.day}
                            initial={notes?.[k.day] ?? ""}
                          />
                        ) : (
                          <span className="text-muted-foreground text-xs">
                            {notes?.[k.day] ?? ""}
                          </span>
                        )}
                      </td>
                    ) : null}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
