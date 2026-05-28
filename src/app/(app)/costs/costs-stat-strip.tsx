import { DollarSign, Sparkles, TrendingUp } from "lucide-react";

import type { Breakdown } from "@/lib/analytics/costs";

function usd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `$${value.toFixed(2)}`;
}

/** 3-tile stat strip at the top of /costs — Total spend ·
 *  Cost / Goal Met · daily-spend sparkline. Round 21 — dropped the
 *  Cost-per-call tile because that figure already lives on the Calls
 *  page header strip; duplicating it here was noise. */
export function CostsStatStrip({
  spend,
  goalMet,
  daily,
}: {
  spend: Breakdown;
  goalMet: number;
  daily: number[];
}) {
  const perGoal = goalMet === 0 ? null : spend.total / goalMet;
  return (
    <section
      data-testid="costs-stat-strip"
      className="border-border bg-card grid grid-cols-1 gap-x-4 gap-y-3 rounded-xl border px-5 py-4 sm:grid-cols-3"
    >
      <Tile
        icon={<DollarSign className="size-3.5" />}
        label="Total spend"
        value={usd(spend.total)}
        tone="coral"
      />
      <Tile
        icon={<Sparkles className="size-3.5" />}
        label="Cost per Goal Met"
        value={perGoal == null ? "—" : usd(perGoal)}
        tone="coral"
        divider
      />
      <SparklineTile
        label="Daily trend"
        values={daily}
        icon={<TrendingUp className="size-3.5" />}
        divider
      />
    </section>
  );
}

function Tile({
  icon,
  label,
  value,
  tone,
  divider,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone: "coral" | "neutral";
  divider?: boolean;
}) {
  const accent =
    tone === "coral" ? "text-[color:var(--coral)]" : "text-muted-foreground";
  return (
    <div
      className={`flex flex-col gap-1 ${divider ? "sm:border-border/60 sm:border-l sm:pl-4" : ""}`}
    >
      <p className="text-muted-foreground inline-flex items-center gap-1.5 text-[10px] font-medium tracking-[0.16em] uppercase">
        <span className={accent}>{icon}</span>
        {label}
      </p>
      <p className="text-foreground text-2xl leading-none font-medium tabular-nums">
        {value}
      </p>
    </div>
  );
}

function SparklineTile({
  icon,
  label,
  values,
  divider,
}: {
  icon: React.ReactNode;
  label: string;
  values: number[];
  divider?: boolean;
}) {
  return (
    <div
      className={`flex flex-col gap-1 ${divider ? "sm:border-border/60 sm:border-l sm:pl-4" : ""}`}
    >
      <p className="text-muted-foreground inline-flex items-center gap-1.5 text-[10px] font-medium tracking-[0.16em] uppercase">
        <span className="text-[color:var(--coral)]">{icon}</span>
        {label}
      </p>
      <Sparkline values={values} />
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) {
    return <p className="text-muted-foreground text-sm">—</p>;
  }
  const width = 120;
  const height = 32;
  const max = Math.max(0.01, ...values);
  const step = width / (values.length - 1);
  const points = values
    .map((v, i) => {
      const x = i * step;
      const y = height - (v / max) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-8 w-full"
      role="img"
      aria-label="Daily spend trend across the selected window"
      style={{ color: "var(--coral)" }}
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
