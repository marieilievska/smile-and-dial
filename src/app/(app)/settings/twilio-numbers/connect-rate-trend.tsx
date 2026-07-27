import { TrendingDown, TrendingUp } from "lucide-react";

export type DailyStat = {
  /** Eastern calendar day, YYYY-MM-DD. */
  day: string;
  calls: number;
  connected: number;
  /** 0–1, or null when the day had no calls. */
  rate: number | null;
};

const WIDTH = 88;
const HEIGHT = 22;

/** Days with at least one call, oldest first — the only ones worth plotting. */
function plottable(days: DailyStat[]): DailyStat[] {
  return days.filter((d) => d.calls > 0 && d.rate != null);
}

/** Mean rate across a slice, or null when the slice is empty. Weighted by calls
 *  so a 2-call day can't swing the read as hard as a 60-call day. */
function meanRate(days: DailyStat[]): number | null {
  const calls = days.reduce((a, d) => a + d.calls, 0);
  if (calls === 0) return null;
  return days.reduce((a, d) => a + d.connected, 0) / calls;
}

/**
 * Per-number connect-rate trend: the latest rate, a sparkline of the recent
 * days, and a direction arrow comparing the last 3 days against the 4 before
 * them. Replaces the old volume/cap column — with per-number daily caps off,
 * the trend IS the early warning that a number is going bad, so it earns the
 * space that "N calls / cap 100" used to take.
 *
 * Pure presentation: the caller supplies days oldest-first.
 */
export function ConnectRateTrend({
  days,
  liveRate,
  liveCalls,
}: {
  days: DailyStat[];
  /** Rolling 24h rate from the health monitor — shown when today has no row yet. */
  liveRate: number | null;
  liveCalls: number | null;
}) {
  const points = plottable(days);
  const latest = points.length > 0 ? points[points.length - 1] : null;
  const rate = latest?.rate ?? liveRate;
  const calls = latest?.calls ?? liveCalls ?? 0;

  if (rate == null) {
    return (
      <span
        className="text-muted-foreground text-xs"
        title="No outbound calls through this number yet."
      >
        —
      </span>
    );
  }

  const recent = meanRate(points.slice(-3));
  const prior = meanRate(points.slice(-7, -3));
  // Only call a direction when both windows exist and the gap is meaningful —
  // connect rate is noisy day to day and a 1-point wobble means nothing.
  const delta = recent != null && prior != null ? recent - prior : null;
  const direction =
    delta == null || Math.abs(delta) < 0.05 ? null : delta > 0 ? "up" : "down";

  const tooltip = [
    ...points
      .slice(-14)
      .reverse()
      .map(
        (d) =>
          `${d.day}  ${Math.round((d.rate ?? 0) * 100)}%  (${d.connected}/${d.calls})`,
      ),
    points.length === 0 ? "No completed days yet" : "",
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <div className="flex flex-col gap-0.5" title={tooltip}>
      <span className="text-foreground inline-flex items-center gap-1 tabular-nums">
        {Math.round(rate * 100)}%
        {direction === "up" ? (
          <TrendingUp className="size-3 text-emerald-600 dark:text-emerald-400" />
        ) : null}
        {direction === "down" ? (
          <TrendingDown className="size-3 text-rose-600 dark:text-rose-400" />
        ) : null}
      </span>
      <Sparkline points={points.slice(-14)} />
      <span className="text-muted-foreground text-xs tabular-nums">
        {calls} {calls === 1 ? "call" : "calls"}
      </span>
    </div>
  );
}

/** Bare inline SVG sparkline — no chart library, no client JS. Scaled to the
 *  0–100% range rather than the data's own min/max, so two numbers' sparklines
 *  are directly comparable and a flat-but-healthy line doesn't look like a
 *  cliff. */
function Sparkline({ points }: { points: DailyStat[] }) {
  if (points.length < 2) {
    return (
      <span className="text-muted-foreground text-[10px]">no trend yet</span>
    );
  }
  const step = WIDTH / (points.length - 1);
  const path = points
    .map((d, i) => `${i * step},${HEIGHT - (d.rate ?? 0) * HEIGHT}`)
    .join(" ");

  return (
    <svg
      width={WIDTH}
      height={HEIGHT}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className="text-muted-foreground/70 overflow-visible"
      aria-hidden="true"
    >
      <polyline
        points={path}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
