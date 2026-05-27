import { Phone, PhoneCall, Plus, Trophy } from "lucide-react";
import Link from "next/link";

import type { LeadStats } from "./stats-query";

/** 4-stat strip under the Leads page header. Each stat is a one-click
 *  filter shortcut: click "Callbacks due" and you land on the leads
 *  page already filtered to status=callback.
 *
 *  Coral accents the "needs attention" stats (Ready to call, Callbacks
 *  due). The "good news" Sale-this-week sits in emerald. Added-today
 *  is neutral. */
export function LeadsStatStrip({ stats }: { stats: LeadStats }) {
  return (
    <section
      data-testid="leads-stat-strip"
      className="border-border bg-card animate-in fade-in slide-in-from-bottom-1 fill-mode-both grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl border px-5 py-4 duration-500 sm:grid-cols-4"
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
      />
      <StatLink
        icon={<Trophy className="size-3.5" />}
        label="Sale this week"
        value={stats.saleThisWeek}
        href="/leads?status=sale"
        tone="emerald"
      />
      <StatLink
        icon={<Plus className="size-3.5" />}
        label="Added today"
        value={stats.addedToday}
        href={`/leads?created_from=${new Date().toISOString().slice(0, 10)}`}
        tone="neutral"
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
        {value.toLocaleString()}
      </p>
    </Link>
  );
}
