import { ArrowDown, ArrowUp, Minus } from "lucide-react";

/** KPI tile that optionally renders a compare-period delta. `pctDelta` of
 *  `null` is "previous was zero", which we render as a dash. */
export function KpiTile({
  label,
  value,
  hint,
  pctDelta,
  badge,
}: {
  label: string;
  value: string;
  hint?: string;
  pctDelta?: number | null;
  badge?: { label: string; tone: "info" | "warn" } | null;
}) {
  return (
    <div
      data-testid="kpi-tile"
      data-label={label}
      className="border-border bg-card flex flex-col gap-1 rounded-lg border p-4"
    >
      <div className="flex items-center gap-2">
        <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          {label}
        </p>
        {badge ? (
          <span
            data-testid="kpi-badge"
            className={
              badge.tone === "warn"
                ? "rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium tracking-wide text-amber-800 uppercase dark:bg-amber-950 dark:text-amber-200"
                : "bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-[10px] font-medium tracking-wide uppercase"
            }
          >
            {badge.label}
          </span>
        ) : null}
      </div>
      <p className="text-foreground text-2xl font-semibold">{value}</p>
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
      {pctDelta !== undefined ? <DeltaBadge value={pctDelta} /> : null}
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
      ? "text-emerald-600 dark:text-emerald-400"
      : "text-rose-600 dark:text-rose-400";
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
