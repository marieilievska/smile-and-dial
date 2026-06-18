import { TrendingDown, TrendingUp } from "lucide-react";

function usd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `$${value.toFixed(2)}`;
}

/** Hero card: total spend for the range, the vs-previous-period delta (down is
 *  good on a cost page), the month-end projection + today's spend, and a static
 *  daily-spend area chart. Plain SVG (same approach as PerTimeChart) so no
 *  charting dependency is added. */
export function CostsHero({
  total,
  spendDelta,
  projectedMonthSpend,
  todaySpend,
  daily,
}: {
  total: number;
  spendDelta: number | null;
  projectedMonthSpend: number;
  todaySpend: number;
  daily: number[];
}) {
  const width = 720;
  const height = 132;
  const padding = 14;
  const innerW = width - padding * 2;
  const innerH = height - padding * 2;
  const max = Math.max(0.01, ...daily);
  const step = daily.length > 1 ? innerW / (daily.length - 1) : 0;
  const points = daily
    .map((v, i) => {
      const x = padding + i * step;
      const y = padding + (innerH - (v / max) * innerH);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const filled =
    daily.length > 1
      ? `${padding},${height - padding} ${points} ${padding + (daily.length - 1) * step},${height - padding}`
      : "";

  const down = spendDelta != null && spendDelta < 0;
  const deltaPct = spendDelta == null ? null : Math.abs(spendDelta * 100);

  return (
    <section
      data-testid="costs-hero"
      className="border-border bg-card rounded-2xl border p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-muted-foreground text-[11px] font-medium tracking-[0.14em] uppercase">
            Total spend
          </p>
          <div className="mt-1.5 flex items-baseline gap-3">
            <span className="text-foreground text-4xl leading-none font-medium tabular-nums">
              {usd(total)}
            </span>
            {deltaPct != null ? (
              <span
                className={`inline-flex items-center gap-1 text-sm ${down ? "text-success" : "text-destructive"}`}
              >
                {down ? (
                  <TrendingDown className="size-4" />
                ) : (
                  <TrendingUp className="size-4" />
                )}
                {deltaPct.toFixed(1)}%
              </span>
            ) : null}
          </div>
          <p className="text-muted-foreground mt-1.5 text-xs">
            vs the prior period
          </p>
        </div>
        <div className="text-right">
          <p className="text-muted-foreground text-[11px] font-medium tracking-[0.14em] uppercase">
            Projected month-end
          </p>
          <p className="text-foreground mt-1.5 text-xl font-medium tabular-nums">
            {usd(projectedMonthSpend)}
          </p>
          <p className="text-muted-foreground mt-1.5 text-xs tabular-nums">
            {usd(todaySpend)} today
          </p>
        </div>
      </div>
      <div className="mt-5">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="h-32 w-full"
          role="img"
          aria-label="Daily spend across the selected range"
          style={{ color: "var(--primary)" }}
        >
          <defs>
            <linearGradient id="hero-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity={0.24} />
              <stop offset="100%" stopColor="currentColor" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          {daily.length > 1 ? (
            <>
              <polygon points={filled} fill="url(#hero-area)" />
              <polyline
                points={points}
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </>
          ) : null}
        </svg>
      </div>
    </section>
  );
}
