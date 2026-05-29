import { Clock } from "lucide-react";

import { Badge } from "@/components/ui/badge";

import { formatCallingHours } from "./format-hours";

/** Shared presentational bits for the campaigns table + board so both
 *  views render identical live signals (status, dialing pulse, spend
 *  bar, attention rail). All server-safe — no client hooks. */

function humanize(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

/** Campaign lifecycle palette.
 *  - active  → success (green, dialing right now)
 *  - paused  → warning (yellow, intentionally stopped; needs attention)
 *  - draft   → secondary (grey, not running yet)
 *  - ended   → destructive (red, permanently off; audit only) */
function statusVariant(
  status: string,
): "success" | "warning" | "destructive" | "secondary" {
  if (status === "active") return "success";
  if (status === "paused") return "warning";
  if (status === "ended") return "destructive";
  return "secondary";
}

export function CampaignStatusBadge({ status }: { status: string }) {
  return (
    <Badge variant={statusVariant(status)} dot>
      {humanize(status)}
    </Badge>
  );
}

/** Inline spend-cap bar. Current spend with a thin progress bar against
 *  the daily cap. Amber when nearing the cap (>=80%), red when over.
 *  Falls back to the dollar number alone when no cap is set. */
export function SpendCapBar({
  spend,
  cap,
}: {
  spend: number;
  cap: number | null;
}) {
  const dollars = `$${spend.toFixed(2)}`;
  if (!cap || cap <= 0) {
    return (
      <span className="text-foreground font-mono text-xs tabular-nums">
        {dollars}
      </span>
    );
  }
  const pct = Math.min(100, Math.round((spend / cap) * 100));
  const tone =
    pct >= 100
      ? "bg-destructive"
      : pct >= 80
        ? "bg-warning"
        : "bg-foreground/70";
  return (
    <div className="flex flex-col gap-1">
      <span className="text-foreground font-mono text-xs tabular-nums">
        {dollars}{" "}
        <span className="text-muted-foreground">/ ${cap.toFixed(0)}</span>
      </span>
      <div className="bg-muted h-1 w-full overflow-hidden rounded-full">
        <div
          className={`h-full ${tone} transition-[width] duration-300`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/** Lists-attached indicator. Zero lists is an amber warning — the
 *  campaign has no one to dial. */
export function ListsBadge({ count }: { count: number }) {
  if (count === 0) {
    return (
      <span
        className="text-warning bg-warning/10 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium"
        title="No lists attached — this campaign won't dial."
      >
        No lists
      </span>
    );
  }
  return (
    <span className="text-foreground text-xs tabular-nums">
      {count} list{count === 1 ? "" : "s"}
    </span>
  );
}

/** Live "Dialing now" chip — green pulse. Shown when a campaign is
 *  active AND the current time is inside its calling window: the AI is
 *  placing calls this second. */
export function DialingNowChip() {
  return (
    <span
      className="text-success inline-flex items-center gap-1.5 text-[11px] font-medium"
      title="Active and inside calling hours — the AI is placing calls right now."
    >
      <span className="relative flex size-2">
        <span className="bg-success absolute inline-flex size-full animate-ping rounded-full opacity-75" />
        <span className="bg-success relative inline-flex size-2 rounded-full" />
      </span>
      Dialing now
    </span>
  );
}

/** Amber "Outside hours" chip — an active campaign that's paused for
 *  the night because the clock is outside its calling window. */
export function OutsideHoursChip() {
  return (
    <span
      className="text-warning bg-warning/10 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium"
      title="Current time is outside calling hours; the dialer won't start new calls."
    >
      Outside hours
    </span>
  );
}

/** Left attention-rail color for a campaign row/card.
 *   - active + no lists  → broken (red): it can't dial
 *   - active + off-hours → idle for now (amber)
 *   - otherwise          → transparent (no rail) */
export function attentionRail(opts: {
  isActive: boolean;
  insideHours: boolean;
  listCount: number;
}): string {
  if (opts.isActive && opts.listCount === 0)
    return "border-l-[color:var(--destructive)]";
  if (opts.isActive && !opts.insideHours)
    return "border-l-[color:var(--warning)]";
  return "border-l-transparent";
}

export function HoursLabel({
  start,
  end,
}: {
  start: string | null;
  end: string | null;
}) {
  return (
    <span className="text-foreground inline-flex items-center gap-1 text-xs">
      <Clock className="size-3 shrink-0" />
      {formatCallingHours(start, end)}
    </span>
  );
}
