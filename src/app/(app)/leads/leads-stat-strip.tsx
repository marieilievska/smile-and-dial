import { Phone, PhoneCall, Trophy } from "lucide-react";
import Link from "next/link";

import type { LeadStats } from "./stats-query";

/** 3-stat strip under the Leads page header. Each stat is a one-click
 *  filter shortcut: click "Callbacks due" and you land on the leads
 *  page already filtered to status=callback.
 *
 *  Coral accents the "needs attention" stats (Ready to call, Callbacks
 *  due). The "good news" Goals-met-this-week sits in emerald.
 *
 *  Round 30 — dropped the "Added today" tile (D3, 4→3). It was the
 *  only non-actionable stat (just a recency count) and the primary
 *  cell already surfaces recency on each row. Three tiles read as
 *  intentional triage shortcuts rather than a generic dashboard. */
export function LeadsStatStrip({ stats }: { stats: LeadStats }) {
  return (
    <section
      data-testid="leads-stat-strip"
      className="border-border bg-card animate-in fade-in slide-in-from-bottom-2 fill-mode-both grid grid-cols-1 gap-x-4 gap-y-3 rounded-2xl border px-5 py-4 shadow-sm delay-100 duration-500 sm:grid-cols-3"
    >
      <StatLink
        icon={<Phone className="size-3.5" />}
        label="Ready to call"
        value={stats.readyToCall}
        href="/leads?status=ready_to_call"
        tone="coral"
      />
      <StatLink
        icon={<PhoneCall className="size-3.5" />}
        label="Callbacks due"
        value={stats.callbacksDue}
        href="/leads?status=callback"
        tone="coral"
        divider
      />
      <StatLink
        icon={<Trophy className="size-3.5" />}
        label="Goals met this week"
        value={stats.goalsMetThisWeek}
        // Count and destination show the SAME set: goal-met calls from this
        // week. The Calls list, filtered to goal_met=yes and scoped from the
        // week's Monday, mirrors the count's calls + ended_at window.
        href={`/calls?goal_met=yes&from=${stats.weekStartDate}`}
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
  value: number;
  href: string;
  tone: "coral" | "emerald" | "neutral";
  divider?: boolean;
}) {
  const accent = {
    coral: "text-primary",
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
        {value.toLocaleString()}
      </p>
    </Link>
  );
}
