import { ArrowDown, ArrowUp, ArrowUpRight, Minus } from "lucide-react";
import Link from "next/link";

/** The page's primary metric. Appointments today, with an inline
 *  sparkline of hourly bookings and a pace-vs-yesterday comparison.
 *
 *  Round 26 — toned down from the round-T4 "bigger hero typography"
 *  experiment. The Referrizer design spec specifically flags
 *  oversized hero numbers on operational pages as drift. The metric
 *  still leads the page but at product-sized 4xl instead of
 *  marketing-sized 7xl, with the supporting sparkline given equal
 *  footing rather than being a side-decoration. */
export function HeroPace({
  current,
  yesterdayByNow,
  yesterdayTotal,
  hourly,
}: {
  current: number;
  yesterdayByNow: number;
  yesterdayTotal: number;
  hourly: number[];
}) {
  // Delta vs yesterday's same wall-clock time (more useful than vs
  // full-day total before the day is over).
  const delta = current - yesterdayByNow;
  const pct =
    yesterdayByNow === 0
      ? current === 0
        ? 0
        : null
      : (current - yesterdayByNow) / yesterdayByNow;

  return (
    <section
      data-testid="hero-pace"
      className="border-border bg-card animate-in fade-in slide-in-from-bottom-2 fill-mode-both relative rounded-2xl border p-6 shadow-sm delay-100 duration-500"
    >
      {/* Round 29 — small "See analytics" affordance in the corner so
       *  the Today operational view and the Analytics retrospective
       *  view tell one story together. */}
      <Link
        href="/analytics"
        className="text-muted-foreground hover:text-foreground absolute top-3 right-3 inline-flex items-center gap-1 text-xs transition-colors"
        aria-label="Open analytics for windowed goal-completion trends"
      >
        See analytics
        <ArrowUpRight className="size-3" />
      </Link>
      <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between md:gap-8">
        <div className="flex flex-col gap-2.5">
          <p className="text-muted-foreground text-[10px] font-medium tracking-[0.18em] uppercase">
            Goals met today
          </p>
          <p className="text-foreground text-4xl leading-none font-semibold tracking-tight tabular-nums">
            {current}
          </p>
          <PaceLine
            delta={delta}
            pct={pct}
            yesterdayByNow={yesterdayByNow}
            yesterdayTotal={yesterdayTotal}
          />
        </div>
        <HourlySparkline hourly={hourly} />
      </div>
    </section>
  );
}

function PaceLine({
  delta,
  pct,
  yesterdayByNow,
  yesterdayTotal,
}: {
  delta: number;
  pct: number | null;
  yesterdayByNow: number;
  yesterdayTotal: number;
}) {
  // No prior data → calm muted line.
  if (pct == null) {
    return (
      <p className="text-muted-foreground inline-flex items-center gap-1.5 text-sm">
        <Minus className="size-3.5" />
        No goals met yesterday to compare against yet
      </p>
    );
  }

  const pctValue = pct * 100;
  const isFlat = Math.abs(pctValue) < 0.5 && delta === 0;
  const up = delta > 0;
  const Icon = isFlat ? Minus : up ? ArrowUp : ArrowDown;
  const color = isFlat
    ? "text-muted-foreground"
    : up
      ? "text-emerald-600 dark:text-emerald-400"
      : "text-rose-600 dark:text-rose-400";

  let phrase: string;
  if (isFlat) {
    phrase = `Even with yesterday's pace at this hour (${yesterdayByNow})`;
  } else if (up) {
    phrase = `Ahead of yesterday's pace by ${delta} (was ${yesterdayByNow} by now)`;
  } else {
    phrase = `Behind yesterday's pace by ${Math.abs(delta)} (was ${yesterdayByNow} by now)`;
  }

  return (
    <div className="flex flex-col gap-0.5">
      <p
        className={`inline-flex items-center gap-1.5 text-sm font-medium ${color}`}
      >
        <Icon className="size-3.5" />
        {phrase}
      </p>
      {yesterdayTotal > 0 ? (
        <p className="text-muted-foreground text-xs">
          Yesterday closed at {yesterdayTotal}
        </p>
      ) : null}
    </div>
  );
}

/** Inline 24-bar hourly sparkline. Round 26 — the current hour is now
 *  differentiated by opacity rather than colour. After the Referrizer
 *  token swap (`--coral` aliased to `--primary`), the old coral/navy
 *  contrast collapsed into one hue, but the opacity ramp (past 0.55,
 *  now 1.0, future 0.18) still carries the "you are here" cue and
 *  reads as more cohesive than mixing two accent colours. */
function HourlySparkline({ hourly }: { hourly: number[] }) {
  const width = 320;
  const height = 80;
  const padding = 4;
  const innerW = width - padding * 2;
  const innerH = height - padding * 2;
  const max = Math.max(1, ...hourly);
  const barW = innerW / 24;
  const currentHour = new Date().getHours();
  const baseY = height - padding;

  // Soft gradient area underlay that traces the booking curve up to the
  // current hour — a calm "shape of the day" behind the precise bars.
  // We only draw the area through `now`; the future has no data to plot.
  const gradientId = "hero-spark-fill";
  const pointX = (h: number) => padding + h * barW + barW / 2;
  const pointY = (count: number) => padding + (innerH - (count / max) * innerH);
  const areaThrough = Math.min(currentHour, 23);
  const linePts = hourly
    .slice(0, areaThrough + 1)
    .map((count, h) => `${pointX(h).toFixed(1)},${pointY(count).toFixed(1)}`);
  const areaPath =
    linePts.length > 0
      ? `M ${pointX(0).toFixed(1)},${baseY} L ${linePts.join(" L ")} L ${pointX(
          areaThrough,
        ).toFixed(1)},${baseY} Z`
      : "";
  const nowX = pointX(Math.min(currentHour, 23));

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-20 w-full md:w-80"
      role="img"
      aria-label="Goals met per hour today"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.22} />
          <stop offset="100%" stopColor="var(--primary)" stopOpacity={0} />
        </linearGradient>
      </defs>

      {/* Gradient area underlay */}
      {areaPath ? <path d={areaPath} fill={`url(#${gradientId})`} /> : null}

      {/* Per-hour bars on top — opacity carries past/now/future */}
      {hourly.map((count, h) => {
        const bh = (count / max) * innerH;
        const x = padding + h * barW;
        const y = padding + (innerH - bh);
        const isFuture = h > currentHour;
        const isNow = h === currentHour;
        const fill = isFuture ? "var(--muted-foreground)" : "var(--primary)";
        const opacity = isFuture ? 0.18 : count === 0 ? 0.18 : isNow ? 1 : 0.45;
        return (
          <rect
            key={h}
            x={x + 1}
            y={y}
            width={Math.max(1, barW - 2)}
            height={Math.max(2, bh)}
            fill={fill}
            opacity={opacity}
            rx={2}
          />
        );
      })}

      {/* Faint "now" marker — a dashed vertical line + cap dot so the eye
       *  lands on the current hour. */}
      <line
        x1={nowX}
        y1={padding}
        x2={nowX}
        y2={baseY}
        stroke="var(--primary)"
        strokeOpacity={0.35}
        strokeWidth={1}
        strokeDasharray="2 3"
      />
      <circle cx={nowX} cy={padding + 1} r={1.6} fill="var(--primary)" />

      {/* Baseline */}
      <line
        x1={padding}
        y1={baseY}
        x2={width - padding}
        y2={baseY}
        stroke="currentColor"
        strokeOpacity={0.12}
      />
    </svg>
  );
}
