import { Activity, AlertCircle, AlertTriangle, Clock } from "lucide-react";
import Link from "next/link";

import { formatEventWhen } from "./format-when";
import type { SystemHealthStats } from "./stats-query";

/** 4-tile stat strip at the top of /system-health. Errors / Warnings /
 *  Total events / Last event time across the last 24h. The Errors and
 *  Warnings tiles are clickable filter shortcuts; Last event is
 *  read-only context. */
export function SystemHealthStatStrip({
  stats,
  now,
}: {
  stats: SystemHealthStats;
  /** Server-passed `now` (ISO) so the relative time matches the
   *  initial render and we don't see a flash on hydration. */
  now: string;
}) {
  const nowDate = new Date(now);
  const lastEventLabel = stats.lastEventAt
    ? formatEventWhen(stats.lastEventAt, nowDate)
    : "—";
  return (
    <section
      data-testid="system-health-stat-strip"
      className="border-border bg-card animate-in fade-in slide-in-from-bottom-1 fill-mode-both grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl border px-5 py-4 duration-500 sm:grid-cols-4"
    >
      <StatLink
        icon={<AlertCircle className="size-3.5" />}
        label="Errors · 24h"
        value={stats.errors24h.toLocaleString()}
        href="/system-health?severity=error"
        tone="red"
      />
      <StatLink
        icon={<AlertTriangle className="size-3.5" />}
        label="Warnings · 24h"
        value={stats.warns24h.toLocaleString()}
        href="/system-health?severity=warn"
        tone="coral"
        divider
      />
      <StatLink
        icon={<Activity className="size-3.5" />}
        label="Events · 24h"
        value={stats.total24h.toLocaleString()}
        href="/system-health"
        tone="neutral"
        divider
      />
      <StatTile
        icon={<Clock className="size-3.5" />}
        label="Last event"
        value={lastEventLabel}
        valueClass="text-base"
        tooltip={
          stats.lastEventAt
            ? new Date(stats.lastEventAt).toLocaleString()
            : undefined
        }
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
  tone: "coral" | "red" | "neutral";
  divider?: boolean;
}) {
  const accent = {
    coral: "text-[color:var(--coral)]",
    red: "text-destructive",
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

function StatTile({
  icon,
  label,
  value,
  valueClass,
  tooltip,
  divider,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  valueClass?: string;
  tooltip?: string;
  divider?: boolean;
}) {
  return (
    <div
      className={`flex flex-col gap-1 ${divider ? "sm:border-border/60 sm:border-l sm:pl-4" : ""}`}
      title={tooltip}
    >
      <p className="text-muted-foreground inline-flex items-center gap-1.5 text-[10px] font-medium tracking-[0.16em] uppercase">
        <span className="text-muted-foreground">{icon}</span>
        {label}
      </p>
      <p
        className={`text-foreground leading-none font-medium tabular-nums ${valueClass ?? "text-2xl"}`}
      >
        {value}
      </p>
    </div>
  );
}
