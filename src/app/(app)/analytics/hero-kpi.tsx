import { ArrowDown, ArrowUp, Minus } from "lucide-react";

/** Hero KPI for the dashboard's North Star Metric. Larger than KpiTile,
 *  carries an inline sparkline, and uses absolute prior-period framing
 *  ("was 19") instead of just a percentage so the eye doesn't have to
 *  reverse-compute the comparison. */
export function HeroKpi({
  label,
  value,
  priorValue,
  deltaPct,
  sparkline,
  helper,
  badge,
}: {
  label: string;
  value: string;
  priorValue?: number | null;
  deltaPct?: number | null;
  sparkline?: number[];
  helper?: string;
  badge?: { label: string; tone: "info" | "warn" } | null;
}) {
  const showDelta = deltaPct !== undefined;
  return (
    <div
      data-testid="hero-kpi"
      data-label={label}
      className="border-border bg-card flex flex-col gap-3 rounded-lg border p-6 md:flex-row md:items-center md:justify-between"
    >
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            {label}
          </p>
          {badge ? (
            <span
              data-testid="hero-kpi-badge"
              className={
                badge.tone === "warn"
                  ? "rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium tracking-wide text-amber-800 uppercase dark:bg-amber-950 dark:text-amber-200"
                  : "bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-[10px] font-medium tracking-wide uppercase"
              }
            >
              {badge.label}
            </span>
          ) : null}
        </div>
        <p className="text-foreground text-5xl leading-none font-semibold">
          {value}
        </p>
        {showDelta ? (
          <DeltaLine value={deltaPct ?? null} priorValue={priorValue} />
        ) : helper ? (
          <p className="text-muted-foreground text-sm">{helper}</p>
        ) : null}
      </div>
      {sparkline && sparkline.length > 1 ? (
        <Sparkline values={sparkline} />
      ) : null}
    </div>
  );
}

function DeltaLine({
  value,
  priorValue,
}: {
  value: number | null;
  priorValue?: number | null;
}) {
  if (value == null) {
    return (
      <p className="text-muted-foreground inline-flex items-center gap-1 text-sm">
        <Minus className="size-3" />
        no prior data
      </p>
    );
  }
  const pct = value * 100;
  const isFlat = Math.abs(pct) < 0.5;
  const up = pct > 0;
  const Icon = isFlat ? Minus : up ? ArrowUp : ArrowDown;
  const color = isFlat
    ? "text-muted-foreground"
    : up
      ? "text-emerald-600 dark:text-emerald-400"
      : "text-rose-600 dark:text-rose-400";
  return (
    <p className={`inline-flex items-center gap-1.5 text-sm ${color}`}>
      <Icon className="size-3.5" />
      {Math.abs(pct).toFixed(0)}% vs prior period
      {priorValue != null ? (
        <span className="text-muted-foreground">
          (was {priorValue.toLocaleString()})
        </span>
      ) : null}
    </p>
  );
}

/** Tiny inline-SVG sparkline. Designed to feel like part of the typography,
 *  not a chart — no axes, no labels, no tooltips. */
function Sparkline({ values }: { values: number[] }) {
  const width = 180;
  const height = 50;
  const max = Math.max(1, ...values);
  const min = 0;
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const points = values
    .map((v, i) => {
      const x = i * step;
      const y = height - ((v - min) / (max - min || 1)) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="text-primary h-12 w-44 shrink-0"
      role="img"
      aria-label="Trend over the selected window"
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.85}
      />
    </svg>
  );
}
