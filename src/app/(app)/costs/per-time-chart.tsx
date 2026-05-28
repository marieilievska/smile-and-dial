"use client";

import { useState } from "react";

import type { PerTime } from "@/lib/analytics/costs";

/** Daily-spend area chart for the Per-day view. Round 20 — replaces
 *  the list-of-bars treatment with a real client-side chart that
 *  reads as a trend. Hovering surfaces a tooltip with the day, spend,
 *  and call count for that bucket. */
export function PerTimeChart({ data }: { data: PerTime[] }) {
  const width = 720;
  const height = 200;
  const padding = 24;
  const innerW = width - padding * 2;
  const innerH = height - padding * 2;
  const max = Math.max(0.01, ...data.map((d) => d.spend));
  const step = data.length > 1 ? innerW / (data.length - 1) : 0;
  const points = data
    .map((d, i) => {
      const x = padding + i * step;
      const y = padding + (innerH - (d.spend / max) * innerH);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const filled =
    data.length > 1
      ? `${padding},${height - padding} ${points} ${padding + (data.length - 1) * step},${height - padding}`
      : "";

  const [hover, setHover] = useState<number | null>(null);

  const totalSpend = data.reduce((a, b) => a + b.spend, 0);
  const totalCalls = data.reduce((a, b) => a + b.calls, 0);
  const avgPerDay = data.length === 0 ? 0 : totalSpend / data.length;

  function fmtDay(iso: string): string {
    const d = new Date(`${iso}T00:00:00Z`);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  return (
    <div
      data-testid="per-time-chart"
      className="border-border bg-card relative rounded-xl border p-5"
    >
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-foreground text-sm font-semibold">
          Spend over time
        </h2>
        <p className="text-muted-foreground text-xs tabular-nums">
          ${totalSpend.toFixed(2)} total · ${avgPerDay.toFixed(2)}/day avg ·{" "}
          {totalCalls.toLocaleString()} calls
        </p>
      </div>
      <div className="relative">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="h-48 w-full"
          role="img"
          aria-label="Spend per day in the selected window"
          style={{ color: "var(--primary)" }}
          onMouseLeave={() => setHover(null)}
        >
          {data.length > 1 ? (
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
          {data.map((d, i) => {
            const x = padding + i * step;
            const y = padding + (innerH - (d.spend / max) * innerH);
            const isHover = hover === i;
            return (
              <g key={d.day}>
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
            data-testid="per-time-tooltip"
            className="bg-popover text-popover-foreground border-border pointer-events-none absolute top-1 rounded-md border px-2.5 py-1.5 text-xs shadow-sm"
            style={{
              left: `min(calc(${((padding + hover * step) / width) * 100}% + 8px), calc(100% - 11rem))`,
            }}
          >
            <p className="text-muted-foreground">{fmtDay(data[hover].day)}</p>
            <p className="text-foreground font-medium tabular-nums">
              ${data[hover].spend.toFixed(2)}
            </p>
            <p className="text-muted-foreground tabular-nums">
              {data[hover].calls.toLocaleString()}{" "}
              {data[hover].calls === 1 ? "call" : "calls"}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
