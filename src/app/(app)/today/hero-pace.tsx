import { ArrowDown, ArrowUp, Minus } from "lucide-react";

/** The page's one big number. Appointments today, with an inline
 *  sparkline of hourly bookings and a pace-vs-yesterday comparison.
 *
 *  v2 — typography is larger (7xl, medium weight), spacing is more
 *  generous (p-10, gap-3), and the sparkline's "now" bar uses coral so
 *  the eye lands on the present moment. */
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
      className="border-border bg-card animate-in fade-in slide-in-from-bottom-2 fill-mode-both rounded-2xl border p-8 delay-100 duration-500 md:p-10"
    >
      <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between md:gap-8">
        <div className="flex flex-col gap-3">
          <p className="text-muted-foreground text-[10px] font-medium tracking-[0.18em] uppercase">
            Appointments today
          </p>
          <p className="text-foreground text-6xl leading-none font-medium tracking-tight tabular-nums md:text-7xl">
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
        No appointments yesterday to compare against yet
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

/** Inline 24-bar hourly sparkline. Current hour gets a coral accent so
 *  the eye lands on "now". Past hours use the primary (navy) at varying
 *  opacity; future hours sit faintly in the background. */
function HourlySparkline({ hourly }: { hourly: number[] }) {
  const width = 320;
  const height = 80;
  const padding = 4;
  const innerW = width - padding * 2;
  const innerH = height - padding * 2;
  const max = Math.max(1, ...hourly);
  const barW = innerW / 24;
  const currentHour = new Date().getHours();
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-20 w-full md:w-80"
      role="img"
      aria-label="Appointments booked per hour today"
    >
      {hourly.map((count, h) => {
        const bh = (count / max) * innerH;
        const x = padding + h * barW;
        const y = padding + (innerH - bh);
        const isFuture = h > currentHour;
        const isNow = h === currentHour;
        // Now bar uses coral (var(--coral)). Past hours use primary
        // (navy). Future hours fade into the background.
        const fill = isNow
          ? "var(--coral)"
          : isFuture
            ? "var(--muted-foreground)"
            : "var(--primary)";
        const opacity = isFuture ? 0.18 : count === 0 ? 0.18 : isNow ? 1 : 0.55;
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
      <line
        x1={padding}
        y1={height - padding}
        x2={width - padding}
        y2={height - padding}
        stroke="currentColor"
        strokeOpacity={0.12}
      />
    </svg>
  );
}
