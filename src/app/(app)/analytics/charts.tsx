import { Trophy } from "lucide-react";

import type {
  FunnelStep,
  OutcomeBucket,
  TimeBucket,
  CampaignRank,
} from "@/lib/analytics/stats";
import { outcomeBadgeVariant } from "@/lib/outcome-style";

/** Map an outcome's semantic tier (the same green/amber/red/grey system the
 *  calls pages use) to a bar color, so the outcome breakdown reads by meaning. */
const OUTCOME_TIER_COLOR: Record<string, string> = {
  success: "var(--success)",
  warning: "var(--warning)",
  destructive: "var(--destructive)",
  secondary: "var(--muted-foreground)",
  coral: "var(--primary)",
};

function outcomeBarColor(outcome: string): string {
  return OUTCOME_TIER_COLOR[outcomeBadgeVariant(outcome)] ?? "var(--primary)";
}

/** Horizontal bar — top step is the widest, every subsequent step is a
 *  percentage of the prior. Used for the conversion funnel. Round 17 —
 *  drop-off labels promoted from a small grey number to a coral pill on
 *  the bar itself, plus a "of dialed" share line under each step. */
export function FunnelChart({ steps }: { steps: FunnelStep[] }) {
  const top = Math.max(1, steps[0]?.count ?? 1);
  return (
    <div data-testid="funnel" className="flex flex-col gap-3">
      {steps.map((s, i) => {
        const pct = (s.count / top) * 100;
        const prev = i === 0 ? null : steps[i - 1].count;
        const stepDrop =
          prev != null && prev > 0 ? ((prev - s.count) / prev) * 100 : null;
        const ofDialed = top > 0 ? (s.count / top) * 100 : 0;
        // Tint the bar by how much we lost coming into this step: a steep
        // drop-off is a leak, so it goes amber (>=35%) or red (>=60%). The
        // top step (Dialed) has no prior, so it stays coral.
        const barTone =
          stepDrop == null
            ? "bg-primary"
            : stepDrop >= 60
              ? "bg-destructive"
              : stepDrop >= 35
                ? "bg-warning"
                : "bg-primary";
        const dropTone =
          stepDrop == null
            ? "text-muted-foreground"
            : stepDrop >= 60
              ? "text-destructive"
              : stepDrop >= 35
                ? "text-warning"
                : "text-muted-foreground";
        return (
          <div key={s.label} className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between text-sm">
              <span className="text-foreground font-medium">{s.label}</span>
              <span className="text-muted-foreground tabular-nums">
                {s.count.toLocaleString()}
                {i > 0 ? (
                  <span className="text-muted-foreground/70 ml-1.5 text-xs">
                    ({ofDialed.toFixed(0)}% of dialed)
                  </span>
                ) : null}
              </span>
            </div>
            <div
              className="bg-muted relative h-3 w-full overflow-hidden rounded"
              title={`${s.label}: ${s.count.toLocaleString()}${stepDrop != null ? ` · ${stepDrop.toFixed(0)}% drop-off from prior step` : ""}`}
            >
              <div
                className={`${barTone} h-full transition-[width] duration-300`}
                style={{ width: `${Math.max(2, pct)}%` }}
              />
            </div>
            {stepDrop != null && stepDrop > 0 ? (
              <p
                className={`inline-flex items-center gap-1 self-end text-[11px] ${dropTone}`}
              >
                <span className="size-1.5 rounded-full bg-current" />−
                {stepDrop.toFixed(0)}% drop-off from prior step
              </p>
            ) : null}
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
            >
              <title>{`${b.day}: ${b.count} calls`}</title>
            </rect>
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
              <span className="text-muted-foreground tabular-nums">
                {b.count.toLocaleString()} ({pct.toFixed(0)}%)
              </span>
            </div>
            <div
              className="bg-muted h-2 w-full overflow-hidden rounded"
              title={`${b.outcome.replace(/_/g, " ")}: ${b.count} (${pct.toFixed(1)}%)`}
            >
              <div
                className="h-full"
                style={{
                  width: `${Math.max(1, pct)}%`,
                  background: outcomeBarColor(b.outcome),
                }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Top-3 medal tint. Gold / silver / bronze — applied as a tiny pill in
 *  front of the rank for the leaderboard. */
const MEDALS: { bg: string; ring: string; text: string; label: string }[] = [
  {
    bg: "bg-amber-100 dark:bg-amber-950",
    ring: "ring-amber-300/60 dark:ring-amber-700/60",
    text: "text-amber-800 dark:text-amber-200",
    label: "Gold",
  },
  {
    bg: "bg-slate-100 dark:bg-slate-800",
    ring: "ring-slate-300/60 dark:ring-slate-600/60",
    text: "text-slate-700 dark:text-slate-200",
    label: "Silver",
  },
  {
    bg: "bg-orange-100 dark:bg-orange-950",
    ring: "ring-orange-300/60 dark:ring-orange-700/60",
    text: "text-orange-800 dark:text-orange-200",
    label: "Bronze",
  },
];

/** Top campaigns by Goal Met. Round 17 — top 3 get gold/silver/bronze
 *  rank pills so the leaderboard reads at a glance. */
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
      {rows.slice(0, 8).map((r, i) => {
        const medal = i < 3 ? MEDALS[i] : null;
        return (
          <li
            key={r.campaignId}
            className="flex items-center justify-between gap-3"
          >
            <div className="flex min-w-0 items-center gap-2">
              {medal ? (
                <span
                  data-testid="leaderboard-medal"
                  data-rank={i + 1}
                  className={`inline-flex size-6 items-center justify-center rounded-full ring-1 ${medal.bg} ${medal.ring} ${medal.text} text-[11px] font-semibold`}
                  title={`${medal.label} — rank ${i + 1}`}
                >
                  {i === 0 ? <Trophy className="size-3" /> : i + 1}
                </span>
              ) : (
                <span className="text-muted-foreground inline-flex size-6 items-center justify-center text-xs tabular-nums">
                  {i + 1}
                </span>
              )}
              <span className="text-foreground truncate">{r.campaignName}</span>
            </div>
            <span className="text-muted-foreground whitespace-nowrap tabular-nums">
              {r.goalMet} {r.goalMet === 1 ? "goal" : "goals"} · $
              {r.spend.toFixed(2)} ·{" "}
              {r.costPerGoalMet > 0
                ? `$${r.costPerGoalMet.toFixed(2)}/goal`
                : "—"}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
