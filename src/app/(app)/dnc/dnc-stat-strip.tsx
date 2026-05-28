import { Ban, CalendarPlus, FileDown, TrendingUp } from "lucide-react";
import Link from "next/link";

import type { DncStats } from "./stats-query";

const REASON_LABELS: Record<string, string> = {
  dnc_requested: "Caller requested",
  invalid_number: "Invalid number",
  language_barrier: "Language barrier",
  manual: "Manual",
  imported: "Imported",
};

/** 4-stat strip under the /dnc header. Mirrors the callbacks and calls
 *  strips — tile-per-stat, each tile a clickable filter shortcut that
 *  pre-applies a relevant URL param.
 *
 *  The "Top reason" tile renders as a non-link when the list is empty,
 *  since there's nothing to filter to. */
export function DncStatStrip({ stats }: { stats: DncStats }) {
  const topLabel = stats.topReason
    ? (REASON_LABELS[stats.topReason.key] ?? stats.topReason.key)
    : "—";
  const importedPct =
    stats.total === 0 ? "—" : `${Math.round(stats.importedShare * 100)}%`;

  return (
    <section
      data-testid="dnc-stat-strip"
      className="border-border bg-card grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl border px-5 py-4 sm:grid-cols-4"
    >
      <StatTile
        icon={<Ban className="size-3.5" />}
        label="Total on DNC"
        value={stats.total.toLocaleString()}
        href="/dnc"
        tone="neutral"
      />
      <StatTile
        icon={<CalendarPlus className="size-3.5" />}
        label="Added this week"
        value={stats.addedThisWeek.toLocaleString()}
        href="/dnc"
        tone="coral"
        divider
      />
      <StatTile
        icon={<TrendingUp className="size-3.5" />}
        label="Top reason"
        value={topLabel}
        valueClass="text-base"
        href={stats.topReason ? `/dnc?reason=${stats.topReason.key}` : null}
        tone="neutral"
        divider
      />
      <StatTile
        icon={<FileDown className="size-3.5" />}
        label="Imported share"
        value={importedPct}
        href="/dnc?reason=imported"
        tone="neutral"
        divider
      />
    </section>
  );
}

function StatTile({
  icon,
  label,
  value,
  valueClass,
  href,
  tone,
  divider,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  valueClass?: string;
  href: string | null;
  tone: "coral" | "neutral";
  divider?: boolean;
}) {
  const accent = {
    coral: "text-primary",
    neutral: "text-muted-foreground",
  }[tone];

  const divClass = divider ? "sm:border-border/60 sm:border-l sm:pl-4" : "";
  const body = (
    <>
      <p className="text-muted-foreground inline-flex items-center gap-1.5 text-[10px] font-medium tracking-[0.16em] uppercase">
        <span className={accent}>{icon}</span>
        {label}
      </p>
      <p
        className={`text-foreground leading-none font-medium tabular-nums ${valueClass ?? "text-2xl"}`}
      >
        {value}
      </p>
    </>
  );

  if (!href) {
    return <div className={`flex flex-col gap-1 ${divClass}`}>{body}</div>;
  }
  return (
    <Link
      href={href}
      className={`group focus-visible:ring-ring/60 hover:bg-muted/40 -mx-2 flex flex-col gap-1 rounded-lg px-2 py-1 transition-colors focus-visible:ring-2 focus-visible:outline-none ${divClass}`}
    >
      {body}
    </Link>
  );
}
