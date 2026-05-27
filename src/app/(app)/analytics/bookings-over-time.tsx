/** Daily appointments-booked line chart. Tighter sibling of CallsOverTime
 *  — single series, axis-free, designed to live directly under the hero
 *  KPI. */
export function BookingsOverTime({ daily }: { daily: number[] }) {
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
  return (
    <div
      data-testid="bookings-over-time"
      className="border-border bg-card rounded-lg border p-4"
    >
      <h2 className="text-foreground mb-3 text-sm font-semibold">
        Appointments booked over time
      </h2>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="text-primary h-40 w-full"
        role="img"
        aria-label="Appointments booked per day in the selected window"
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
        <line
          x1={padding}
          y1={height - padding}
          x2={width - padding}
          y2={height - padding}
          stroke="currentColor"
          strokeOpacity={0.18}
        />
      </svg>
    </div>
  );
}
