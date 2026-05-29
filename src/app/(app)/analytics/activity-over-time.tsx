"use client";

import { useState } from "react";

/** One day-by-day series the chart can plot. `format` decides how the
 *  totals + tooltip render — counts vs dollars. Functions can't cross the
 *  server→client boundary, so the parent passes a format *tag*, not a
 *  formatter. */
export type ActivitySeries = {
  key: string;
  /** Toggle button label, e.g. "Appointments". */
  label: string;
  /** One value per day in the window. */
  values: number[];
  format: "count" | "usd";
  /** Singular noun for the tooltip, e.g. "appointment". */
  noun: string;
};

function fmt(value: number, format: ActivitySeries["format"]): string {
  if (format === "usd") return `$${value.toFixed(2)}`;
  return value.toLocaleString();
}

/** Switchable day-by-day trend. Round 34 — replaces the single
 *  appointments-only line with a segmented toggle across Appointments /
 *  Calls / Spend, so the owner can see *all three* over time from one
 *  chart instead of guessing call volume and spend from the KPI tiles.
 *  Keeps the `bookings-over-time` test id so existing coverage holds. */
export function ActivityOverTime({
  series,
  startDate,
}: {
  series: ActivitySeries[];
  startDate?: string;
}) {
  const [activeKey, setActiveKey] = useState(series[0]?.key ?? "");
  const [hover, setHover] = useState<number | null>(null);
  const active = series.find((s) => s.key === activeKey) ?? series[0];
  const daily = active?.values ?? [];

  const width = 720;
  const height = 160;
  const padding = 16;
  const innerW = width - padding * 2;
  const innerH = height - padding * 2;
  const max = Math.max(1, ...daily);
  const step = daily.length > 1 ? innerW / (daily.length - 1) : 0;
  const points = daily
    .map((v, i) => {
      const x = padding + i * step;
      const y = padding + (innerH - (v / max) * innerH);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const filled = `${padding},${height - padding} ${points} ${padding + (daily.length - 1) * step},${height - padding}`;
  const total = daily.reduce((a, b) => a + b, 0);
  const peak = Math.max(0, ...daily);

  function labelForIndex(i: number): string {
    if (!startDate) return `Day ${i + 1}`;
    const d = new Date(`${startDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  return (
    <div
      data-testid="bookings-over-time"
      className="border-border bg-card relative rounded-xl border p-5"
    >
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-center gap-3">
          <h2 className="text-foreground text-sm font-semibold">
            Activity over time
          </h2>
          {/* Segmented toggle — one chart, three lenses. */}
          <div
            role="group"
            aria-label="Choose the metric to plot over time"
            className="border-border bg-muted/40 inline-flex items-center gap-0.5 rounded-lg border p-0.5"
          >
            {series.map((s) => {
              const isActive = s.key === active?.key;
              return (
                <button
                  key={s.key}
                  type="button"
                  data-testid="activity-toggle"
                  data-active={isActive || undefined}
                  aria-pressed={isActive}
                  onClick={() => {
                    setActiveKey(s.key);
                    setHover(null);
                  }}
                  className={
                    isActive
                      ? "bg-primary text-primary-foreground rounded-md px-2.5 py-1 text-xs font-medium transition-colors"
                      : "text-muted-foreground hover:text-foreground rounded-md px-2.5 py-1 text-xs font-medium transition-colors"
                  }
                >
                  {s.label}
                </button>
              );
            })}
          </div>
        </div>
        <p className="text-muted-foreground text-xs tabular-nums">
          {fmt(total, active?.format ?? "count")} total · peak{" "}
          {fmt(peak, active?.format ?? "count")}/day
        </p>
      </div>
      <div className="relative">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="h-40 w-full"
          role="img"
          aria-label={`${active?.label ?? "Activity"} per day in the selected window`}
          style={{ color: "var(--primary)" }}
          onMouseLeave={() => setHover(null)}
        >
          <defs>
            <linearGradient id="aot-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity={0.28} />
              <stop offset="100%" stopColor="currentColor" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          {daily.length > 1 ? (
            <>
              <polygon points={filled} fill="url(#aot-area)" />
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
          {daily.map((v, i) => {
            const x = padding + i * step;
            const y = padding + (innerH - (v / max) * innerH);
            const isHover = hover === i;
            return (
              <g key={i}>
                <rect
                  x={x - Math.max(6, step / 2)}
                  y={padding}
                  width={Math.max(12, step)}
                  height={innerH}
                  fill="transparent"
                  onMouseEnter={() => setHover(i)}
                  style={{ cursor: "crosshair" }}
                />
                {isHover ? (
                  <>
                    <line
                      x1={x}
                      y1={padding}
                      x2={x}
                      y2={height - padding}
                      stroke="currentColor"
                      strokeOpacity={0.25}
                      strokeDasharray="2 2"
                    />
                    <circle cx={x} cy={y} r={4} fill="currentColor" />
                  </>
                ) : null}
              </g>
            );
          })}
          <line
            x1={padding}
            y1={height - padding}
            x2={width - padding}
            y2={height - padding}
            stroke="currentColor"
            strokeOpacity={0.18}
          />
        </svg>
        {hover != null && active ? (
          <div
            data-testid="activity-tooltip"
            className="bg-popover text-popover-foreground border-border pointer-events-none absolute top-1 rounded-md border px-2.5 py-1.5 text-xs shadow-sm"
            style={{
              left: `min(calc(${((padding + hover * step) / width) * 100}% + 8px), calc(100% - 10rem))`,
            }}
          >
            <p className="text-muted-foreground">{labelForIndex(hover)}</p>
            <p className="text-foreground font-medium tabular-nums">
              {active.format === "usd"
                ? fmt(daily[hover], "usd")
                : `${daily[hover].toLocaleString()} ${
                    daily[hover] === 1 ? active.noun : `${active.noun}s`
                  }`}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
