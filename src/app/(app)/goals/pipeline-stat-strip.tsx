import { CalendarX, ListChecks, Sparkles, Trophy } from "lucide-react";
import Link from "next/link";

/** 4-stat strip on the /goals pipeline view. Each tile is a clickable
 *  filter shortcut into the pipeline.
 *   - In pipeline       — every status except Closed
 *   - Awaiting attended — count(goal_met)
 *   - No-shows to rebook — count(no_show)
 *   - Sales this week   — count(sale) WHERE moved_at >= 7d */
export type PipelineStats = {
  inPipeline: number;
  awaitingAttended: number;
  noShows: number;
  salesThisWeek: number;
};

export function PipelineStatStrip({ stats }: { stats: PipelineStats }) {
  return (
    <section
      data-testid="pipeline-stat-strip"
      className="border-border bg-card animate-in fade-in slide-in-from-bottom-1 fill-mode-both grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl border px-5 py-4 duration-500 sm:grid-cols-4"
    >
      <StatLink
        icon={<ListChecks className="size-3.5" />}
        label="In pipeline"
        value={stats.inPipeline.toLocaleString()}
        href="/goals?status=open"
        tone="neutral"
      />
      <StatLink
        icon={<Sparkles className="size-3.5" />}
        label="Awaiting attended"
        value={stats.awaitingAttended.toLocaleString()}
        href="/goals?status=goal_met"
        tone="coral"
        divider
      />
      <StatLink
        icon={<CalendarX className="size-3.5" />}
        label="No-shows to rebook"
        value={stats.noShows.toLocaleString()}
        href="/goals?status=no_show"
        tone="red"
        divider
      />
      <StatLink
        icon={<Trophy className="size-3.5" />}
        label="Sales this week"
        value={stats.salesThisWeek.toLocaleString()}
        href="/goals?status=sale"
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
  tone: "coral" | "emerald" | "red" | "neutral";
  divider?: boolean;
}) {
  const accent = {
    coral: "text-[color:var(--coral)]",
    emerald: "text-emerald-600 dark:text-emerald-400",
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
