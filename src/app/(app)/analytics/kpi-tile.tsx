import { ArrowDown, ArrowUp, ArrowUpRight, Minus } from "lucide-react";

/** Supporting KPI tile — sits alongside the HeroKpi in a unified strip.
 *  Round 17:
 *  - Matched padding and animation to HeroKpi so the strip reads as one
 *    cohesive band.
 *  - Warning-tone badge now uses the project's text-warning palette
 *    (was raw amber utilities) so it lines up with every other warning
 *    badge in the app.
 *  - Optional `cta` renders a "View →" affordance in the corner when the
 *    tile is wrapped in a Link, so the click intent is explicit. */
export function KpiTile({
  label,
  value,
  hint,
  pctDelta,
  badge,
  cta,
}: {
  label: string;
  value: string;
  hint?: string;
  pctDelta?: number | null;
  badge?: { label: string; tone: "info" | "warn" } | null;
  /** Renders a small "View →" affordance in the top-right when this tile
   *  is wrapped in a navigation Link. */
  cta?: string;
}) {
  return (
    <div
      data-testid="kpi-tile"
      data-label={label}
      className="border-border bg-card relative flex flex-col gap-1.5 rounded-xl border p-5"
    >
      <div className="flex items-center gap-2">
        <p className="text-muted-foreground text-[10px] font-semibold tracking-[0.16em] uppercase">
          {label}
        </p>
        {badge ? (
          <span
            data-testid="kpi-badge"
            className={
              badge.tone === "warn"
                ? "text-warning bg-warning/10 rounded-full px-2 py-0.5 text-[10px] font-medium tracking-wide uppercase"
                : "bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-[10px] font-medium tracking-wide uppercase"
            }
          >
            {badge.label}
          </span>
        ) : null}
      </div>
      <p className="text-foreground text-2xl font-semibold tabular-nums">
        {value}
      </p>
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
      {pctDelta !== undefined ? <DeltaBadge value={pctDelta} /> : null}
      {cta ? (
        <span className="text-muted-foreground absolute top-3 right-3 inline-flex items-center gap-1 text-[11px]">
          {cta}
          <ArrowUpRight className="size-3" />
        </span>
      ) : null}
    </div>
  );
}

function DeltaBadge({ value }: { value: number | null }) {
  if (value == null) {
    return (
      <p
        data-testid="kpi-delta"
        className="text-muted-foreground inline-flex items-center gap-1 text-xs"
      >
        <Minus className="size-3" />
        no prior data
      </p>
    );
  }
  const pct = value * 100;
  const isFlat = Math.abs(pct) < 0.5;
  const up = pct > 0;
  const Icon = isFlat ? Minus : up ? ArrowUp : ArrowDown;
  const color = isFlat
    ? "text-muted-foreground"
    : up
      ? "text-success"
      : "text-destructive";
  return (
    <p
      data-testid="kpi-delta"
      className={`inline-flex items-center gap-1 text-xs ${color}`}
    >
      <Icon className="size-3" />
      {Math.abs(pct).toFixed(0)}% vs prior
    </p>
  );
}
