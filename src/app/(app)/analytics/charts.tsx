import type {
  FunnelStep,
  OutcomeBucket,
  TimeBucket,
  CampaignRank,
} from "@/lib/analytics/stats";

/** Horizontal bar — top step is the widest, every subsequent step is a
 *  percentage of the prior. Used for the conversion funnel. */
export function FunnelChart({ steps }: { steps: FunnelStep[] }) {
  const top = Math.max(1, steps[0]?.count ?? 1);
  return (
    <div data-testid="funnel" className="flex flex-col gap-2">
      {steps.map((s, i) => {
        const pct = (s.count / top) * 100;
        const prev = i === 0 ? null : steps[i - 1].count;
        const stepDrop =
          prev != null && prev > 0 ? ((prev - s.count) / prev) * 100 : null;
        return (
          <div key={s.label} className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between text-sm">
              <span className="text-foreground font-medium">{s.label}</span>
              <span className="text-muted-foreground">
                {s.count.toLocaleString()}
                {stepDrop != null ? (
                  <span className="ml-2 text-xs">−{stepDrop.toFixed(0)}%</span>
                ) : null}
              </span>
            </div>
            <div className="bg-muted h-3 w-full overflow-hidden rounded">
              <div
                className="bg-primary h-full"
                style={{ width: `${Math.max(2, pct)}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Vertical bar chart of count-per-day, drawn as inline SVG. */
export function CallsOverTime({ buckets }: { buckets: TimeBucket[] }) {
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const width = 600;
  const height = 140;
  const padding = 24;
  const innerW = width - padding * 2;
  const innerH = height - padding * 2;
  const barW = buckets.length === 0 ? 0 : innerW / buckets.length;
  return (
    <div data-testid="calls-over-time" className="w-full overflow-x-auto">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="text-primary h-36 w-full"
        role="img"
        aria-label="Calls over time"
      >
        {buckets.map((b, i) => {
          const h = (b.count / max) * innerH;
          const x = padding + i * barW;
          const y = padding + (innerH - h);
          return (
            <rect
              key={b.day}
              x={x + 1}
              y={y}
              width={Math.max(1, barW - 2)}
              height={h}
              fill="currentColor"
              opacity={b.count === 0 ? 0.15 : 0.85}
            />
          );
        })}
        <line
          x1={padding}
          y1={height - padding}
          x2={width - padding}
          y2={height - padding}
          stroke="currentColor"
          strokeOpacity={0.2}
        />
      </svg>
    </div>
  );
}

/** Outcome list with inline bars — same data a donut would carry, simpler
 *  to read at a glance. */
export function OutcomeBreakdown({
  buckets,
  total,
}: {
  buckets: OutcomeBucket[];
  total: number;
}) {
  if (total === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No outcomes in this range.
      </p>
    );
  }
  return (
    <ul data-testid="outcome-breakdown" className="flex flex-col gap-2 text-sm">
      {buckets.map((b) => {
        const pct = (b.count / total) * 100;
        return (
          <li key={b.outcome} className="flex flex-col gap-1">
            <div className="text-foreground flex items-baseline justify-between">
              <span className="capitalize">{b.outcome.replace(/_/g, " ")}</span>
              <span className="text-muted-foreground">
                {b.count.toLocaleString()} ({pct.toFixed(0)}%)
              </span>
            </div>
            <div className="bg-muted h-2 w-full overflow-hidden rounded">
              <div
                className="bg-primary h-full"
                style={{ width: `${Math.max(1, pct)}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Top campaigns by Goal Met. */
export function CampaignLeaderboard({ rows }: { rows: CampaignRank[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No campaigns active in this range.
      </p>
    );
  }
  return (
    <ul
      data-testid="campaign-leaderboard"
      className="flex flex-col gap-2 text-sm"
    >
      {rows.slice(0, 8).map((r) => (
        <li key={r.campaignId} className="flex items-baseline justify-between">
          <span className="text-foreground truncate pr-3">
            {r.campaignName}
          </span>
          <span className="text-muted-foreground whitespace-nowrap">
            {r.goalMet} goals · ${r.spend.toFixed(2)} ·{" "}
            {r.costPerGoalMet > 0
              ? `$${r.costPerGoalMet.toFixed(2)}/goal`
              : "—"}
          </span>
        </li>
      ))}
    </ul>
  );
}
