/** Tiny inline-SVG sparkline of DNC additions over the last 14 days.
 *  Server-safe (pure SVG, no state) — sits beside the header count so
 *  the owner can see at a glance whether the list is growing steadily
 *  or just spiked. Renders nothing when there's no activity to show. */
export function DncSparkline({ values }: { values: number[] }) {
  const total = values.reduce((a, b) => a + b, 0);
  if (values.length < 2 || total === 0) return null;

  const width = 72;
  const height = 20;
  const max = Math.max(1, ...values);
  const step = width / (values.length - 1);
  const points = values
    .map((v, i) => {
      const x = i * step;
      const y = height - (v / max) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <span
      className="text-muted-foreground inline-flex items-center gap-1.5 text-xs"
      title={`${total.toLocaleString()} added in the last 14 days`}
    >
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-5 w-[72px]"
        role="img"
        aria-label="DNC additions over the last 14 days"
        style={{ color: "var(--primary)" }}
        preserveAspectRatio="none"
      >
        <polyline
          points={points}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span className="hidden sm:inline">last 14 days</span>
    </span>
  );
}
