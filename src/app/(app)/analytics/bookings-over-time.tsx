"use client";

import { useState } from "react";

/** Daily appointments-booked line chart. Round 17 — added hover state so
 *  pointing at a day surfaces a tooltip with the date + count. Still
 *  axis-free; the trend shape carries the story and the tooltip carries
 *  the precision. */
export function BookingsOverTime({
  daily,
  startDate,
}: {
  daily: number[];
  /** YYYY-MM-DD of the first datapoint, used to label hover tooltips. */
  startDate?: string;
}) {
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

  const [hover, setHover] = useState<number | null>(null);

  function labelForIndex(i: number): string {
    if (!startDate) return `Day ${i + 1}`;
    const d = new Date(`${startDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  }

  const total = daily.reduce((a, b) => a + b, 0);

  return (
    <div
      data-testid="bookings-over-time"
      className="border-border bg-card relative rounded-xl border p-5"
    >
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-foreground text-sm font-semibold">
          Appointments booked over time
        </h2>
        <p className="text-muted-foreground text-xs tabular-nums">
          {total.toLocaleString()} total · peak {max.toLocaleString()}/day
        </p>
      </div>
      <div className="relative">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="h-40 w-full"
          role="img"
          aria-label="Appointments booked per day in the selected window"
          style={{ color: "var(--coral)" }}
          onMouseLeave={() => setHover(null)}
        >
          {daily.length > 1 ? (
            <>
              <polygon points={filled} fill="currentColor" opacity={0.12} />
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
          {/* Per-day hit targets + dot when hovered. */}
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
        {hover != null ? (
          <div
            data-testid="bookings-tooltip"
            className="bg-popover text-popover-foreground border-border pointer-events-none absolute top-1 rounded-md border px-2.5 py-1.5 text-xs shadow-sm"
            style={{
              left: `min(calc(${((padding + hover * step) / width) * 100}% + 8px), calc(100% - 10rem))`,
            }}
          >
            <p className="text-muted-foreground">{labelForIndex(hover)}</p>
            <p className="text-foreground font-medium tabular-nums">
              {daily[hover].toLocaleString()}{" "}
              {daily[hover] === 1 ? "appointment" : "appointments"}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
