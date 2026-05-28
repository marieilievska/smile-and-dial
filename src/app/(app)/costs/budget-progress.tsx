import { AlertTriangle } from "lucide-react";

import type { CampaignCap } from "./stats-query";

function usd(value: number): string {
  if (!Number.isFinite(value)) return "$0.00";
  return `$${value.toFixed(2)}`;
}

/** Inline budget cap progress for a campaign — shown in the Spend
 *  column of the Per-campaign view. When neither daily nor monthly
 *  caps are set, renders nothing (returns null). Else renders the
 *  more-binding of the two caps (whichever is closer to 100%) with a
 *  thin bar tinted by severity:
 *   - under 75% : muted bar (no warning needed)
 *   - 75-90%    : coral (heads up)
 *   - 90%+      : destructive (cap will pause the campaign soon)
 *
 *  Hover/title surfaces both day + month context so the operator
 *  can see why the bar is the colour it is. */
export function BudgetProgress({ cap }: { cap: CampaignCap | undefined }) {
  if (!cap) return null;
  const hasDay = cap.dailySpendCap != null && cap.dailySpendCap > 0;
  const hasMonth = cap.monthlySpendCap != null && cap.monthlySpendCap > 0;
  if (!hasDay && !hasMonth) return null;

  const dayPct = hasDay ? (cap.daySpend / (cap.dailySpendCap ?? 1)) * 100 : 0;
  const monthPct = hasMonth
    ? (cap.monthSpend / (cap.monthlySpendCap ?? 1)) * 100
    : 0;

  // The more-binding cap is whichever is currently closer to 100% —
  // that's the one the user needs to act on.
  const showMonth = hasMonth && (monthPct >= dayPct || !hasDay);
  const pct = showMonth ? monthPct : dayPct;
  const label = showMonth ? "month" : "today";
  const capValue = showMonth ? cap.monthlySpendCap : cap.dailySpendCap;
  const spend = showMonth ? cap.monthSpend : cap.daySpend;

  const tone =
    pct >= 90
      ? { bar: "bg-destructive", text: "text-destructive" }
      : pct >= 75
        ? {
            bar: "",
            text: "text-primary",
          }
        : { bar: "bg-muted-foreground/40", text: "text-muted-foreground" };

  const tooltip = [
    hasDay
      ? `Today: ${usd(cap.daySpend)} of ${usd(cap.dailySpendCap ?? 0)} (${dayPct.toFixed(0)}%)`
      : null,
    hasMonth
      ? `This month: ${usd(cap.monthSpend)} of ${usd(cap.monthlySpendCap ?? 0)} (${monthPct.toFixed(0)}%)`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      className="flex flex-col items-end gap-0.5"
      data-testid="budget-progress"
      data-rank={pct >= 90 ? "critical" : pct >= 75 ? "warn" : "ok"}
      title={tooltip}
    >
      <div
        className={`inline-flex items-center gap-1 text-[10px] ${tone.text}`}
      >
        {pct >= 90 ? <AlertTriangle className="size-2.5" /> : null}
        <span className="tabular-nums">
          {pct.toFixed(0)}% of {label} cap
        </span>
      </div>
      <div className="bg-muted h-1 w-20 overflow-hidden rounded">
        <div
          className={`h-full ${tone.bar}`}
          style={{
            width: `${Math.min(100, Math.max(2, pct))}%`,
            background:
              pct >= 90 ? undefined : pct >= 75 ? "var(--primary)" : undefined,
          }}
        />
      </div>
      <p className="text-muted-foreground text-[10px] tabular-nums">
        {usd(spend)} / {usd(capValue ?? 0)}
      </p>
    </div>
  );
}
