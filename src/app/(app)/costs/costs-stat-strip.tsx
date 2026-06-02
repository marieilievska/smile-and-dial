import {
  ArrowDownRight,
  ArrowUpRight,
  CalendarRange,
  DollarSign,
  Target,
  TrendingUp,
} from "lucide-react";

import type { Breakdown } from "@/lib/analytics/costs";

function usd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `$${value.toFixed(2)}`;
}

/** 4-tile stat strip at the top of /costs:
 *   - Total spend (with a vs-previous-period delta)
 *   - Cost per Goal Met
 *   - This month (month-to-date + month-end projection) — fixed to the
 *     workspace, so it answers "am I on track?" regardless of the
 *     page's date filter
 *   - Daily-spend sparkline
 */
export function CostsStatStrip({
  spend,
  goalMet,
  daily,
  spendDelta,
  periodNumberCost = 0,
  monthlyNumberCost = 0,
  mtdSpend,
  projectedMonthSpend,
  todaySpend,
}: {
  spend: Breakdown;
  goalMet: number;
  daily: number[];
  /** Fractional change vs the previous equal-length window. null when
   *  there was no spend in the prior window to compare against. */
  spendDelta: number | null;
  /** Phone-number rental for the selected window, folded into Total spend. */
  periodNumberCost?: number;
  /** Phone-number rental for a full month, folded into the This-month tile. */
  monthlyNumberCost?: number;
  mtdSpend: number;
  projectedMonthSpend: number;
  todaySpend: number;
}) {
  // Cost per Goal Met stays a per-call metric (excludes flat number rental).
  const perGoal = goalMet === 0 ? null : spend.total / goalMet;
  const totalSpend = spend.total + periodNumberCost;
  return (
    <section
      data-testid="costs-stat-strip"
      className="border-border bg-card grid grid-cols-2 gap-x-4 gap-y-4 rounded-xl border px-5 py-4 lg:grid-cols-4"
    >
      <Tile
        icon={<DollarSign className="size-3.5" />}
        label="Total spend"
        value={usd(totalSpend)}
        delta={spendDelta}
      />
      <Tile
        icon={<Target className="size-3.5" />}
        label="Cost per Goal Met"
        value={perGoal == null ? "—" : usd(perGoal)}
        divider
      />
      <div className="lg:border-border/60 flex flex-col gap-1 lg:border-l lg:pl-4">
        <p className="text-muted-foreground inline-flex items-center gap-1.5 text-[10px] font-medium tracking-[0.16em] uppercase">
          <span className="text-primary">
            <CalendarRange className="size-3.5" />
          </span>
          This month
        </p>
        <p className="text-foreground text-2xl leading-none font-medium tabular-nums">
          {usd(mtdSpend + monthlyNumberCost)}
        </p>
        <p className="text-muted-foreground text-[11px] tabular-nums">
          ~{usd(projectedMonthSpend + monthlyNumberCost)} projected ·{" "}
          {usd(todaySpend)} today
        </p>
      </div>
      <SparklineTile
        label="Daily trend"
        values={daily}
        icon={<TrendingUp className="size-3.5" />}
        divider
      />
    </section>
  );
}

function Tile({
  icon,
  label,
  value,
  delta,
  divider,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  delta?: number | null;
  divider?: boolean;
}) {
  return (
    <div
      className={`flex flex-col gap-1 ${divider ? "lg:border-border/60 lg:border-l lg:pl-4" : ""}`}
    >
      <p className="text-muted-foreground inline-flex items-center gap-1.5 text-[10px] font-medium tracking-[0.16em] uppercase">
        <span className="text-primary">{icon}</span>
        {label}
      </p>
      <p className="text-foreground text-2xl leading-none font-medium tabular-nums">
        {value}
      </p>
      {delta != null ? <DeltaChip delta={delta} /> : null}
    </div>
  );
}

/** vs-previous-period delta. Up is red here — for a cost page, rising
 *  spend is the thing to notice, not celebrate. */
function DeltaChip({ delta }: { delta: number }) {
  const pct = Math.round(Math.abs(delta) * 100);
  if (pct === 0) {
    return (
      <span className="text-muted-foreground text-[11px]">
        Flat vs prev. period
      </span>
    );
  }
  const up = delta > 0;
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-[11px] tabular-nums ${up ? "text-destructive" : "text-success"}`}
    >
      {up ? (
        <ArrowUpRight className="size-3" />
      ) : (
        <ArrowDownRight className="size-3" />
      )}
      {pct}% vs prev. period
    </span>
  );
}

function SparklineTile({
  icon,
  label,
  values,
  divider,
}: {
  icon: React.ReactNode;
  label: string;
  values: number[];
  divider?: boolean;
}) {
  return (
    <div
      className={`flex flex-col gap-1 ${divider ? "lg:border-border/60 lg:border-l lg:pl-4" : ""}`}
    >
      <p className="text-muted-foreground inline-flex items-center gap-1.5 text-[10px] font-medium tracking-[0.16em] uppercase">
        <span className="text-primary">{icon}</span>
        {label}
      </p>
      <Sparkline values={values} />
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) {
    return <p className="text-muted-foreground text-sm">—</p>;
  }
  const width = 120;
  const height = 32;
  const max = Math.max(0.01, ...values);
  const step = width / (values.length - 1);
  const points = values
    .map((v, i) => {
      const x = i * step;
      const y = height - (v / max) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-8 w-full"
      role="img"
      aria-label="Daily spend trend across the selected window"
      style={{ color: "var(--primary)" }}
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
