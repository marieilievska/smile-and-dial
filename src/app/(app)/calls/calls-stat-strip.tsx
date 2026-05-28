import { PhoneCall, Target, TrendingUp } from "lucide-react";
import Link from "next/link";

import type { CallStats } from "./stats-query";

/** 3-stat strip under the /calls header. Mirrors LeadsStatStrip — tile-
 *  per-stat layout, each tile a clickable filter shortcut.
 *
 *  Round 30 — dropped the "Spend today" tile (D3, 4→3). Calls is an
 *  operational view ("what happened on the phone"); spend lives on
 *  the dedicated /costs page where it has the proper breakdown and
 *  context. Removing it keeps the strip focused on activity. */
export function CallsStatStrip({ stats }: { stats: CallStats }) {
  const today = new Date().toISOString().slice(0, 10);
  return (
    <section
      data-testid="calls-stat-strip"
      className="border-border bg-card grid grid-cols-1 gap-x-4 gap-y-3 rounded-xl border px-5 py-4 sm:grid-cols-3"
    >
      <StatLink
        icon={<PhoneCall className="size-3.5" />}
        label="Calls today"
        value={stats.callsToday.toLocaleString()}
        href={`/calls?from=${today}&to=${today}`}
        tone="coral"
      />
      <StatLink
        icon={<TrendingUp className="size-3.5" />}
        label="Connect rate today"
        value={`${(stats.connectRateToday * 100).toFixed(0)}%`}
        href={`/calls?from=${today}&to=${today}`}
        tone="emerald"
        divider
      />
      <StatLink
        icon={<Target className="size-3.5" />}
        label="Goal met today"
        value={stats.goalMetToday.toLocaleString()}
        href={`/calls?from=${today}&to=${today}&goal_met=yes`}
        tone="emerald"
        divider
      />
    </section>
  );
}

function StatLink({
  icon,
  label,
  value,
  href,
  tone,
  divider,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  href: string;
  tone: "coral" | "emerald" | "neutral";
  divider?: boolean;
}) {
  const accent = {
    coral: "text-[color:var(--coral)]",
    emerald: "text-emerald-600 dark:text-emerald-400",
    neutral: "text-muted-foreground",
  }[tone];

  return (
    <Link
      href={href}
      className={`group focus-visible:ring-ring/60 hover:bg-muted/40 -mx-2 flex flex-col gap-1 rounded-lg px-2 py-1 transition-colors focus-visible:ring-2 focus-visible:outline-none ${
        divider ? "sm:border-border/60 sm:border-l sm:pl-4" : ""
      }`}
    >
      <p className="text-muted-foreground inline-flex items-center gap-1.5 text-[10px] font-medium tracking-[0.16em] uppercase">
        <span className={accent}>{icon}</span>
        {label}
      </p>
      <p className="text-foreground text-2xl leading-none font-medium tabular-nums">
        {value}
      </p>
    </Link>
  );
}
