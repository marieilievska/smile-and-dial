import { ArrowDown, ArrowUp, ArrowUpRight, Minus } from "lucide-react";

/** Hero KPI for the dashboard's North Star Metric.
 *
 *  Round 17 refresh:
 *  - Coral Sparkles + uppercase letter-spaced label so the NSM
 *    visually outranks every other KPI on the page.
 *  - Coral-bordered card matching the lead detail / call detail
 *    AI summary treatment.
 *  - Sparkline tinted coral, more substantial size.
 *  - Delta line renders "no prior data" only when prior actually was
 *    zero — checks priorValue first, not just deltaPct.
 *  - When wrapped in a Link, an "View calls →" affordance appears in
 *    the corner so the click intent is explicit (CTA prop opt-in). */
export function HeroKpi({
  label,
  value,
  priorValue,
  deltaPct,
  sparkline,
  helper,
  badge,
  cta,
}: {
  label: string;
  value: string;
  priorValue?: number | null;
  deltaPct?: number | null;
  sparkline?: number[];
  helper?: string;
  badge?: { label: string; tone: "info" | "warn" } | null;
  /** Renders a small "View →" affordance in the top-right when this
   *  tile is wrapped in a navigation Link. */
  cta?: string;
}) {
  const showDelta = deltaPct !== undefined;
  return (
    <div
      data-testid="hero-kpi"
      data-label={label}
      className="bg-card border-border animate-in fade-in slide-in-from-bottom-1 fill-mode-both relative flex flex-col gap-3 rounded-xl border p-6 duration-500 md:flex-row md:items-center md:justify-between"
    >
      <div className="flex flex-1 flex-col gap-1">
        <div className="flex items-center gap-2">
          {/* Round 33 — the coral Sparkles cue moved up to the AI insight
           *  card (the page's single "AI read" moment), so the hero label
           *  is now a quiet KPI label like the comment always intended. */}
          <p className="text-muted-foreground inline-flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.16em] uppercase">
            {label}
          </p>
          {badge ? (
            <span
              data-testid="hero-kpi-badge"
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
        {/* Round 25 — toned down from text-5xl (marketing-hero) to
         *  text-3xl. Operational pages shouldn't shout. */}
        <p className="text-foreground text-3xl leading-none font-semibold tabular-nums">
          {value}
        </p>
        {showDelta ? (
          <DeltaLine value={deltaPct ?? null} priorValue={priorValue} />
        ) : helper ? (
          <p className="text-muted-foreground text-sm">{helper}</p>
        ) : null}
      </div>
      {sparkline && sparkline.length > 1 ? (
        <Sparkline values={sparkline} />
      ) : null}
      {cta ? (
        <span className="text-muted-foreground absolute top-3 right-3 inline-flex items-center gap-1 text-xs">
          {cta}
          <ArrowUpRight className="size-3" />
        </span>
      ) : null}
    </div>
  );
}

function DeltaLine({
  value,
  priorValue,
}: {
  value: number | null;
  priorValue?: number | null;
}) {
  // Round 17 — "no prior data" only when prior was genuinely zero
  // (or null). If we have a prior value but the delta is undefined
  // we still render the prior so the eye has a baseline.
  if (value == null && (priorValue == null || priorValue === 0)) {
    return (
      <p className="text-muted-foreground inline-flex items-center gap-1 text-sm">
        <Minus className="size-3" />
        No prior data to compare
      </p>
    );
  }
  if (value == null) {
    return (
      <p className="text-muted-foreground inline-flex items-center gap-1 text-sm">
        <Minus className="size-3" />
        Prior period: {priorValue?.toLocaleString()}
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
    <p className={`inline-flex items-center gap-1.5 text-sm ${color}`}>
      <Icon className="size-3.5" />
      {Math.abs(pct).toFixed(0)}% vs prior period
      {priorValue != null ? (
        <span className="text-muted-foreground">
          (was {priorValue.toLocaleString()})
        </span>
      ) : null}
    </p>
  );
}

/** Inline-SVG sparkline tinted coral. Round 17 — bumped from 50px tall
 *  to 64px and shifted to coral so the trend reads as part of the
 *  NSM's identity, not a generic decoration. */
function Sparkline({ values }: { values: number[] }) {
  const width = 200;
  const height = 64;
  const max = Math.max(1, ...values);
  const min = 0;
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const points = values
    .map((v, i) => {
      const x = i * step;
      const y = height - ((v - min) / (max - min || 1)) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-16 w-52 shrink-0"
      role="img"
      aria-label="Trend over the selected window"
      style={{ color: "var(--primary)" }}
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
