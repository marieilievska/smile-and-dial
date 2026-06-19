import { type DailyKpi } from "@/lib/agent-analytics/stats";

import { KpiTile } from "../analytics/kpi-tile";
import { ExportCsvButton } from "./export-csv-button";

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
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
    interestYes: 0,
    interestMaybe: 0,
    interestNo: 0,
    warmPct: 0,
  };
}

/** Presentational Dashboard: KPI cards for the selected day + a daily history
 *  table + CSV export. Aggregate counts only — no per-call PII — so it's safe
 *  to render on both the admin page and the public share page. */
export function DashboardView({
  kpis,
  day,
  historyDays,
}: {
  kpis: DailyKpi[];
  day: string;
  historyDays: number;
}) {
  const sel = kpis.find((k) => k.day === day) ?? zeroDay(day);
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
    k.interestYes,
    k.interestMaybe,
    k.interestNo,
    pct(k.warmPct),
  ]);

  return (
    <div className="flex flex-col gap-5">
      <p className="text-muted-foreground text-sm">
        KPIs for <span className="text-foreground font-medium">{day}</span>{" "}
        (Eastern). History below covers the last {historyDays} days.
      </p>

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
        <KpiTile label="Warm %" value={pct(sel.warmPct)} />
      </section>

      <section className="border-border bg-card flex flex-col gap-3 rounded-xl border p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-foreground text-sm font-semibold">
            Daily history
          </h2>
          <ExportCsvButton
            filename="market-research-kpis.csv"
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
              "interest_yes",
              "interest_maybe",
              "interest_no",
              "warm_pct",
            ]}
            rows={exportRows}
          />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-muted-foreground border-border border-b text-left text-xs">
                {[
                  "Day",
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
                  "Yes",
                  "Maybe",
                  "No",
                  "Warm %",
                ].map((h) => (
                  <th
                    key={h}
                    className="px-2 py-2 font-medium whitespace-nowrap"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {kpis.length === 0 ? (
                <tr>
                  <td
                    colSpan={17}
                    className="text-muted-foreground px-2 py-6 text-center"
                  >
                    No calls in the last {historyDays} days.
                  </td>
                </tr>
              ) : (
                kpis.map((k) => (
                  <tr key={k.day} className="border-border/60 border-b">
                    <td className="px-2 py-1.5 font-medium whitespace-nowrap">
                      {k.day}
                    </td>
                    <td className="px-2 py-1.5 tabular-nums">{k.callsMade}</td>
                    <td className="px-2 py-1.5 tabular-nums">{k.connected}</td>
                    <td className="px-2 py-1.5 tabular-nums">{k.convGt1min}</td>
                    <td className="px-2 py-1.5 tabular-nums">{k.dms}</td>
                    <td className="px-2 py-1.5 tabular-nums">{k.callbacks}</td>
                    <td className="px-2 py-1.5 tabular-nums">
                      {k.callbackLater}
                    </td>
                    <td className="px-2 py-1.5 tabular-nums">{k.goals}</td>
                    <td className="px-2 py-1.5 tabular-nums">
                      {k.notInterested}
                    </td>
                    <td className="px-2 py-1.5 tabular-nums">{k.gatekeeper}</td>
                    <td className="px-2 py-1.5 tabular-nums">{k.hungUp}</td>
                    <td className="px-2 py-1.5 tabular-nums">{k.aiError}</td>
                    <td className="px-2 py-1.5 tabular-nums">{k.dnc}</td>
                    <td className="px-2 py-1.5 tabular-nums">
                      {k.interestYes}
                    </td>
                    <td className="px-2 py-1.5 tabular-nums">
                      {k.interestMaybe}
                    </td>
                    <td className="px-2 py-1.5 tabular-nums">{k.interestNo}</td>
                    <td className="px-2 py-1.5 tabular-nums">
                      {pct(k.warmPct)}
                    </td>
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
